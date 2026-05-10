import type { MonitorConfig, MonitorEvent, EmitOptions, LogLevel } from "./types";

const DEFAULT_FLUSH_INTERVAL = 2000;
const DEFAULT_BATCH_SIZE = 20;

export class Monitor {
    private config: Required<
        Pick<MonitorConfig, "service" | "ingestUrl" | "apiKey" | "env" | "flushInterval" | "batchSize" | "debug">
    >;
    private queue: MonitorEvent[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private userId: string = "";
    private jobId: string = "";
    private started = false;

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

        const batch = this.queue.splice(0);
        const payload = batch.map((e) => JSON.stringify(e)).join("\n");

        // Use sendBeacon if available and document is hidden (page unload scenario)
        if (
            typeof navigator !== "undefined" &&
            navigator.sendBeacon &&
            typeof document !== "undefined" &&
            document.visibilityState === "hidden"
        ) {
            const blob = new Blob([payload], { type: "application/x-ndjson" });
            const sent = navigator.sendBeacon(
                `${this.config.ingestUrl}?key=${this.config.apiKey}`,
                blob
            );
            if (!sent && this.config.debug) {
                console.warn("[monitor] sendBeacon failed, events may be lost");
            }
            return;
        }

        // Standard fetch for normal operation
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
            // Re-queue failed events (cap at 200 to prevent memory leak)
            if (this.queue.length < 200) {
                this.queue.unshift(...batch);
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
        this.started = false;
    }

    private start(): void {
        if (this.started) return;
        this.started = true;

        this.timer = setInterval(() => this.flush(), this.config.flushInterval);

        // Flush on page hide (covers tab close, navigation, mobile background)
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

    private errorHandler = (event: ErrorEvent): void => {
        this.emit("client.error.uncaught", "error", {
            data: {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                stack: event.error?.stack,
            },
        });
    };

    private rejectionHandler = (event: PromiseRejectionEvent): void => {
        const reason = event.reason;
        this.emit("client.error.unhandled_rejection", "error", {
            data: {
                message: reason?.message ?? String(reason),
                stack: reason?.stack,
            },
        });
    };

    private installErrorHandler(): void {
        if (typeof window !== "undefined") {
            window.addEventListener("error", this.errorHandler);
        }
    }

    private installRejectionHandler(): void {
        if (typeof window !== "undefined") {
            window.addEventListener("unhandledrejection", this.rejectionHandler);
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
    }
}
