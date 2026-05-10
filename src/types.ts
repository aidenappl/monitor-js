export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface MonitorConfig {
    /** Service name reported with every event */
    service: string;
    /** Monitor ingest URL (e.g. https://monitor-ingest.appleby.cloud/v1/events) */
    ingestUrl: string;
    /** API key for authentication */
    apiKey: string;
    /** Environment name (default: "production") */
    env?: string;
    /** Flush interval in milliseconds (default: 2000) */
    flushInterval?: number;
    /** Max batch size before auto-flush (default: 20) */
    batchSize?: number;
    /** Enable automatic error capture via window.onerror (default: true) */
    captureErrors?: boolean;
    /** Enable automatic unhandled promise rejection capture (default: true) */
    captureUnhandledRejections?: boolean;
    /** Enable debug logging to console (default: false) */
    debug?: boolean;
}

export interface MonitorEvent {
    timestamp: string;
    service: string;
    env: string;
    job_id: string;
    request_id: string;
    trace_id: string;
    user_id: string;
    name: string;
    level: string;
    data: Record<string, unknown>;
}

export interface EmitOptions {
    /** Request ID for cross-service correlation */
    requestId?: string;
    /** Trace ID for distributed tracing */
    traceId?: string;
    /** User ID associated with this event */
    userId?: string;
    /** Arbitrary data payload */
    data?: Record<string, unknown>;
}
