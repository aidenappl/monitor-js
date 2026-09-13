import type { MonitorConfig, MonitorEvent, EmitOptions, LogLevel, MonitorStats } from "./types";
import { isValidCorrelationId, newJobId } from "./ids";

// Minimal ambient shape for the Node `process` global — this package has no
// @types/node dependency and targets the browser too, so `process` may be absent.
// Guarded with `typeof process !== "undefined"` before use.
declare const process:
    | {
          on?(event: string, listener: (...args: unknown[]) => void): void;
          removeListener?(event: string, listener: (...args: unknown[]) => void): void;
      }
    | undefined;

const DEFAULT_FLUSH_INTERVAL = 2000;
const DEFAULT_BATCH_SIZE = 20;
const MAX_QUEUE_SIZE = 500;

/**
 * monitor-core scans NDJSON with a 1 MiB line buffer and rejects the WHOLE
 * request when one line overflows it, so an oversized event is shrunk before it
 * is sent rather than discovered by a 400.
 */
const MAX_LINE_BYTES = 1_000_000;
/** Characters kept per grouping field when an oversized event is shrunk. */
const MAX_FIELD_CHARS = 4096;
/**
 * Browsers refuse a keepalive request once the page's in-flight keepalive
 * bodies exceed 64 KiB, and the refusal is a plain TypeError. Asking for
 * keepalive on a bigger body would fail — and be retried — forever.
 */
const KEEPALIVE_MAX_BYTES = 60_000;
/** Backoff bounds after a transient ingest failure. */
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/** The data keys monitor-core's issue fingerprint reads; they survive shrinking. */
const GROUPING_KEYS = ["error", "error_message", "message", "path", "uri", "method", "reason", "status_code"];

type Outcome = "delivered" | "rejected" | "misconfigured" | "retryable";

/** How an ingest response should be handled. Mirrors go-monitor's classifyStatus. */
function classify(status: number): Outcome {
    if (status >= 200 && status < 400) return "delivered";
    if (status === 408 || status === 429) return "retryable";
    if (status === 401 || status === 403 || status === 404 || status === 405) return "misconfigured";
    if (status >= 400 && status < 500) return "rejected";
    return "retryable";
}

/** Extra requests allowed to isolate malformed events in a batch of n. */
function bisectBudget(n: number): number {
    let depth = 0;
    for (let x = n; x > 1; x = Math.ceil(x / 2)) depth++;
    return 4 * depth + 4;
}

let encoder: TextEncoder | undefined;
function byteLength(s: string): number {
    if (typeof TextEncoder === "undefined") return s.length * 3;
    encoder ??= new TextEncoder();
    return encoder.encode(s).length;
}

/**
 * monitor-core stores level verbatim and groups only exact "error"/"fatal" into
 * issues, so "ERROR" or "warning" would land and silently never be tracked.
 */
function normalizeLevel(level: string): string {
    const l = (level || "info").toLowerCase();
    return l === "warning" ? "warn" : l;
}

export class Monitor {
    private config: Required<
        Pick<MonitorConfig, "service" | "ingestUrl" | "apiKey" | "env" | "flushInterval" | "batchSize" | "debug">
    >;
    private ignoreErrors: (string | RegExp)[] = [];
    private onDrop?: (total: number) => void;
    private queue: MonitorEvent[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private userId: string = "";
    private jobId: string;
    private active = false;
    private backoffUntil = 0;
    private failures = 0;
    private warnedMisconfigured = false;
    private counters = { enqueued: 0, flushed: 0, dropped: 0, quarantined: 0 };

    constructor(config: MonitorConfig) {
        this.config = {
            service: config.service,
            ingestUrl: config.ingestUrl,
            apiKey: config.apiKey,
            env: config.env ?? "production",
            flushInterval: config.flushInterval ?? DEFAULT_FLUSH_INTERVAL,
            batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
            debug: config.debug ?? false,
        };
        this.ignoreErrors = config.ignoreErrors ?? [];
        this.onDrop = config.onDrop;
        // One id per page load (or process): every event from this session
        // shares it, so a session's events can be pulled up together.
        this.jobId = newJobId();

        this.start();

        if (config.captureErrors !== false) {
            this.installErrorHandler();
        }
        if (config.captureUnhandledRejections !== false) {
            this.installRejectionHandler();
        }
    }

    /** Set a persistent user ID for all subsequent events */
    setUser(userId: string): void {
        this.userId = userId;
    }

    /** Clear the user ID */
    clearUser(): void {
        this.userId = "";
    }

    /**
     * Set a persistent job ID (session-level identifier). It must be a UUID or
     * 8-64 hex characters — see `isValidCorrelationId`; anything else is
     * cleared from each event and kept in data.invalid_job_id.
     */
    setJobId(jobId: string): void {
        this.jobId = jobId;
    }

    /** Emit an event at a specific level */
    emit(name: string, level: LogLevel, opts?: EmitOptions): void {
        if (!this.active) return;

        // An id monitor-core would reject is cleared, not sent: one bad id
        // fails the whole request. The original is kept where it is useful.
        let data: Record<string, unknown> = opts?.data ?? {};
        const repair = (field: string, value: string): string => {
            if (isValidCorrelationId(value)) return value;
            data = { ...data, [`invalid_${field}`]: value.slice(0, 128) };
            if (this.config.debug) {
                console.warn(`[monitor] cleared invalid ${field} ${JSON.stringify(value)} (monitor-core accepts a UUID or 8-64 hex characters)`);
            }
            return "";
        };
        const jobId = repair("job_id", this.jobId);
        const requestId = repair("request_id", opts?.requestId ?? "");
        const traceId = repair("trace_id", opts?.traceId ?? "");

        const event: MonitorEvent = {
            timestamp: new Date().toISOString(),
            service: this.config.service,
            env: this.config.env,
            job_id: jobId,
            request_id: requestId,
            trace_id: traceId,
            user_id: opts?.userId ?? this.userId,
            name: name || "event.unnamed",
            level: normalizeLevel(level),
            data,
        };

        if (this.queue.length >= MAX_QUEUE_SIZE) {
            // Drop oldest events to prevent unbounded memory growth
            this.queue.shift();
            this.recordDrop(1);
        }

        this.queue.push(event);
        this.counters.enqueued++;

        if (this.config.debug) {
            console.debug(`[monitor] ${level} ${name}`, opts?.data);
        }

        if (this.queue.length >= this.config.batchSize) {
            this.flush();
        }
    }

    /** Emit a debug event */
    debug(name: string, opts?: EmitOptions): void {
        this.emit(name, "debug", opts);
    }

    /** Emit an info event */
    info(name: string, opts?: EmitOptions): void {
        this.emit(name, "info", opts);
    }

    /** Emit a warning event */
    warn(name: string, opts?: EmitOptions): void {
        this.emit(name, "warn", opts);
    }

    /** Emit an error event */
    error(name: string, opts?: EmitOptions): void {
        this.emit(name, "error", opts);
    }

    /** Emit a fatal event */
    fatal(name: string, opts?: EmitOptions): void {
        this.emit(name, "fatal", opts);
    }

    /**
     * Lifetime counters. Surface them wherever loss would otherwise go
     * unnoticed: the system that would report dropped telemetry is the one
     * dropping it.
     */
    stats(): MonitorStats {
        return { ...this.counters, queued: this.queue.length };
    }

    /** Flush all queued events to the ingest endpoint */
    flush(): void {
        this.flushQueue(false);
    }

    /** Stop the monitor and flush remaining events */
    shutdown(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.flushQueue(true);
        this.removeListeners();
        this.active = false;
    }

    /**
     * @param unloading the page (or process) is going away: ignore the backoff,
     * since this is the last chance these events get.
     */
    private flushQueue(unloading: boolean): void {
        if (this.queue.length === 0) return;

        // Check for global fetch BEFORE removing events from the queue — otherwise
        // on a runtime without fetch (Node <18) the batch would be dropped and lost.
        if (typeof fetch === "undefined") return;

        // After a transient failure, wait out the backoff instead of hitting a
        // struggling ingest again on every emit.
        if (!unloading && Date.now() < this.backoffUntil) return;

        const batch = this.queue.splice(0);
        this.send(batch, { remaining: bisectBudget(batch.length) });
    }

    private send(events: MonitorEvent[], budget: { remaining: number }): void {
        const lines: string[] = [];
        const sent: MonitorEvent[] = [];
        for (const e of events) {
            const line = this.serialize(e);
            if (line === null) {
                this.recordDrop(1);
                continue;
            }
            lines.push(line);
            sent.push(e);
        }
        if (lines.length === 0) return;

        const body = lines.join("\n");
        let request: Promise<{ ok?: boolean; status?: number } | undefined>;
        try {
            request = fetch(this.config.ingestUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-ndjson",
                    "X-Api-Key": this.config.apiKey,
                },
                body,
                keepalive: byteLength(body) <= KEEPALIVE_MAX_BYTES,
            });
        } catch (err) {
            request = Promise.reject(err);
        }

        request.then(
            (res) => this.handleResponse(res, sent, budget),
            (err) => {
                if (this.config.debug) {
                    console.warn("[monitor] flush failed:", err);
                }
                this.retryLater(sent);
            }
        );
    }

    private handleResponse(
        res: { ok?: boolean; status?: number } | undefined,
        events: MonitorEvent[],
        budget: { remaining: number }
    ): void {
        const status = typeof res?.status === "number" ? res.status : 0;
        const outcome: Outcome = res?.ok ? "delivered" : classify(status);

        switch (outcome) {
            case "delivered":
                this.counters.flushed += events.length;
                this.failures = 0;
                this.backoffUntil = 0;
                return;

            case "rejected":
                // Ingest refuses a whole request when one event in it is
                // malformed. Split and resend until the bad one stands alone.
                if (events.length > 1 && budget.remaining > 0) {
                    budget.remaining--;
                    const mid = events.length >> 1;
                    this.send(events.slice(0, mid), budget);
                    this.send(events.slice(mid), budget);
                    return;
                }
                this.counters.quarantined += events.length;
                this.recordDrop(events.length);
                if (this.config.debug) {
                    console.warn(`[monitor] ingest rejected ${events.length} event(s) as malformed (status ${status}):`, events.map((e) => e.name));
                }
                return;

            case "misconfigured":
                // Nothing will be accepted until the key or URL changes.
                this.recordDrop(events.length);
                if (!this.warnedMisconfigured) {
                    this.warnedMisconfigured = true;
                    console.warn(`[monitor] ingest refused events with status ${status} — check ingestUrl and apiKey. Events are being dropped.`);
                }
                return;

            default:
                this.retryLater(events);
        }
    }

    /** Put events back at the front of the queue and back off before retrying. */
    private retryLater(events: MonitorEvent[]): void {
        this.failures++;
        const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(this.failures - 1, 16));
        // Full jitter: every open tab sees ingest recover at the same moment.
        this.backoffUntil = Date.now() + 50 + Math.random() * ceiling;

        const room = MAX_QUEUE_SIZE - this.queue.length;
        const keep = room <= 0 ? [] : events.length > room ? events.slice(events.length - room) : events;
        this.recordDrop(events.length - keep.length);
        if (keep.length > 0) {
            this.queue = keep.concat(this.queue);
        }
    }

    /**
     * One NDJSON line for e, or null if it cannot be serialized. Never throws:
     * flush runs inside emit's auto-flush, and emit must never throw into the
     * caller.
     */
    private serialize(e: MonitorEvent): string | null {
        try {
            const line = JSON.stringify(e);
            // Only strings this long can exceed the limit once UTF-8 encoded.
            if (line.length <= MAX_LINE_BYTES / 3) return line;
            const size = byteLength(line);
            if (size <= MAX_LINE_BYTES) return line;

            const kept: Record<string, unknown> = { truncated: true, original_size_bytes: size };
            for (const k of GROUPING_KEYS) {
                const v = e.data[k];
                if (typeof v === "string") kept[k] = v.slice(0, MAX_FIELD_CHARS);
                else if (typeof v === "number" || typeof v === "boolean") kept[k] = v;
            }
            const shrunk = JSON.stringify({ ...e, data: kept });
            return byteLength(shrunk) <= MAX_LINE_BYTES ? shrunk : null;
        } catch {
            return null;
        }
    }

    private recordDrop(n: number): void {
        if (n <= 0) return;
        this.counters.dropped += n;
        if (this.onDrop) {
            try {
                this.onDrop(this.counters.dropped);
            } catch {
                // A broken callback must not break delivery.
            }
        }
    }

    private start(): void {
        if (this.active) return;
        this.active = true;

        const t = setInterval(() => this.flush(), this.config.flushInterval);
        // In Node, unref() lets the process exit even while the flush timer is pending.
        // Browser timers have no unref(), so guard on its presence.
        if (typeof (t as any).unref === "function") (t as any).unref();
        this.timer = t;

        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", this.handleVisibilityChange);
        }
        if (typeof window !== "undefined") {
            window.addEventListener("pagehide", this.handlePageHide);
        }
    }

    private handleVisibilityChange = (): void => {
        if (document.visibilityState === "hidden") {
            this.flushQueue(true);
        }
    };

    private handlePageHide = (): void => {
        this.flushQueue(true);
    };

    private shouldIgnoreError(message: string, stack?: string): boolean {
        if (this.ignoreErrors.length === 0) return false;
        for (const pattern of this.ignoreErrors) {
            if (typeof pattern === "string") {
                if (message.includes(pattern) || (stack !== undefined && stack.includes(pattern))) {
                    return true;
                }
            } else {
                if (pattern.test(message) || (stack !== undefined && pattern.test(stack))) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * The route a browser error happened on.
     *
     * Deliberately `pathname` only — never the search string or hash. Query
     * parameters routinely carry tokens, emails and other personal data, and this
     * value is both stored on the event and folded into the server-side issue
     * fingerprint, so anything included here is retained and grouped on.
     *
     * Returns undefined outside a browser so the Node handlers stay unaffected.
     */
    private currentPath(): string | undefined {
        if (typeof window === "undefined" || !window.location) return undefined;
        return window.location.pathname;
    }

    private errorHandler = (event: ErrorEvent): void => {
        const stack = event.error?.stack;
        if (this.shouldIgnoreError(event.message ?? "", stack)) return;
        this.emit("client.error.uncaught", "error", {
            data: {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                stack,
                path: this.currentPath(),
            },
        });
    };

    private rejectionHandler = (event: PromiseRejectionEvent): void => {
        const reason = event.reason;
        const message = reason?.message ?? String(reason);
        const stack = reason?.stack;
        if (this.shouldIgnoreError(message, stack)) return;
        this.emit("client.error.unhandled_rejection", "error", {
            data: {
                message,
                stack,
                path: this.currentPath(),
            },
        });
    };

    // --- Node process handlers ---
    // uncaughtException/unhandledRejection are non-terminating here: we report the
    // error and return without calling process.exit, matching the browser handlers'
    // non-terminating behavior. Consumers keep their own crash semantics.

    private nodeExceptionHandler = (err: unknown): void => {
        const e = err as { message?: string; stack?: string } | undefined;
        const message = e?.message ?? String(err);
        const stack = e?.stack;
        if (this.shouldIgnoreError(message, stack)) return;
        this.emit("client.error.uncaught", "error", {
            data: {
                message,
                stack,
            },
        });
    };

    private nodeRejectionHandler = (reason: unknown): void => {
        const r = reason as { message?: string; stack?: string } | undefined;
        const message = r?.message ?? String(reason);
        const stack = r?.stack;
        if (this.shouldIgnoreError(message, stack)) return;
        this.emit("client.error.unhandled_rejection", "error", {
            data: {
                message,
                stack,
            },
        });
    };

    private installErrorHandler(): void {
        if (typeof window !== "undefined") {
            window.addEventListener("error", this.errorHandler);
        } else if (typeof process !== "undefined" && typeof process.on === "function") {
            process.on("uncaughtException", this.nodeExceptionHandler);
        }
    }

    private installRejectionHandler(): void {
        if (typeof window !== "undefined") {
            window.addEventListener("unhandledrejection", this.rejectionHandler);
        } else if (typeof process !== "undefined" && typeof process.on === "function") {
            process.on("unhandledRejection", this.nodeRejectionHandler);
        }
    }

    private removeListeners(): void {
        if (typeof window !== "undefined") {
            window.removeEventListener("error", this.errorHandler);
            window.removeEventListener("unhandledrejection", this.rejectionHandler);
            window.removeEventListener("pagehide", this.handlePageHide);
        }
        if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", this.handleVisibilityChange);
        }
        if (typeof process !== "undefined" && typeof process.removeListener === "function") {
            process.removeListener("uncaughtException", this.nodeExceptionHandler);
            process.removeListener("unhandledRejection", this.nodeRejectionHandler);
        }
    }
}
