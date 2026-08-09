import type { MonitorConfig, MonitorEvent, EmitOptions, LogLevel } from "./types";

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

export class Monitor {
    private config: Required<
        Pick<MonitorConfig, "service" | "ingestUrl" | "apiKey" | "env" | "flushInterval" | "batchSize" | "debug">
    >;
    private ignoreErrors: (string | RegExp)[] = [];
    private queue: MonitorEvent[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private userId: string = "";
    private jobId: string = "";
    private active = false;

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

    /** Set a persistent job ID (session-level identifier) */
    setJobId(jobId: string): void {
        this.jobId = jobId;
    }

    /** Emit an event at a specific level */
    emit(name: string, level: LogLevel, opts?: EmitOptions): void {
        if (!this.active) return;

        const event: MonitorEvent = {
            timestamp: new Date().toISOString(),
            service: this.config.service,
            env: this.config.env,
            job_id: this.jobId,
            request_id: opts?.requestId ?? "",
            trace_id: opts?.traceId ?? "",
            user_id: opts?.userId ?? this.userId,
            name,
            level,
            data: opts?.data ?? {},
        };

        if (this.queue.length >= MAX_QUEUE_SIZE) {
            // Drop oldest events to prevent unbounded memory growth
            this.queue.shift();
        }

        this.queue.push(event);

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

    /** Flush all queued events to the ingest endpoint */
    flush(): void {
        if (this.queue.length === 0) return;

        // Check for global fetch BEFORE removing events from the queue — otherwise
        // on a runtime without fetch (Node <18) the batch would be dropped and lost.
        if (typeof fetch === "undefined") return;

        const batch = this.queue.splice(0);
        const payload = batch.map((e) => JSON.stringify(e)).join("\n");

        fetch(this.config.ingestUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-ndjson",
                "X-Api-Key": this.config.apiKey,
            },
            body: payload,
            keepalive: true,
        }).catch((err) => {
            if (this.config.debug) {
                console.warn("[monitor] flush failed:", err);
            }
            // Re-queue failed events if there's room
            if (this.queue.length + batch.length <= MAX_QUEUE_SIZE) {
                this.queue = batch.concat(this.queue);
            }
        });
    }

    /** Stop the monitor and flush remaining events */
    shutdown(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.flush();
        this.removeListeners();
        this.active = false;
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
            this.flush();
        }
    };

    private handlePageHide = (): void => {
        this.flush();
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
