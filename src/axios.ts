import type { Monitor } from "./client";
import type { LogLevel } from "./types";

interface AxiosInstance {
    interceptors: {
        request: { use: (onFulfilled: (config: any) => any) => void };
        response: {
            use: (onFulfilled: (response: any) => any, onRejected: (error: any) => any) => void;
        };
    };
}

export interface AxiosMonitorOptions {
    /** Only report events for responses with these status codes or above (default: 400) */
    minStatus?: number;
    /** Report successful requests too (default: false) */
    reportSuccess?: boolean;
    /** Paths to ignore (e.g. ["/healthcheck", "/api/health"]) */
    ignorePaths?: string[];
}

/**
 * The request URL without its query string or fragment. Query strings are where
 * tokens and email addresses travel in URLs, and anything reported is retained
 * for the life of the event store.
 */
function stripQuery(url: string): string {
    const i = url.search(/[?#]/);
    return i === -1 ? url : url.slice(0, i);
}

/**
 * A header's value by case-insensitive name, or "" when absent. Works on a
 * plain object (the headers a caller passed, or a Node response) and on
 * axios's AxiosHeaders, whose entries are its own enumerable properties.
 */
function headerValue(headers: unknown, name: string): string {
    if (typeof headers !== "object" || headers === null) return "";
    const want = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === want && typeof v === "string") return v;
    }
    return "";
}

/**
 * The id to report for a request: the one the server echoed in its
 * X-Request-ID response header, else the X-Request-ID the app sent. The request
 * header is what lets a network error (no response at all) still be joined to
 * the server's own log of the request, when the request reached it.
 */
function requestIdOf(config: any, response?: any): string {
    return headerValue(response?.headers, "x-request-id") || headerValue(config?.headers, "x-request-id");
}

/**
 * Attaches Monitor interceptors to an Axios instance.
 * Automatically reports API failures with request_id correlation.
 *
 * Works with both standard axios error handling AND `validateStatus: () => true`
 * (where all HTTP responses go through the fulfilled handler).
 */
export function attachAxiosMonitor(
    axiosInstance: AxiosInstance,
    monitor: Monitor,
    opts?: AxiosMonitorOptions
): void {
    const minStatus = opts?.minStatus ?? 400;
    const reportSuccess = opts?.reportSuccess ?? false;
    const ignorePaths = opts?.ignorePaths ?? [];

    // Stamp request start time, keeping anything else the app put on metadata.
    axiosInstance.interceptors.request.use((config: any) => {
        config.metadata = { ...config.metadata, startTime: Date.now() };
        return config;
    });

    axiosInstance.interceptors.response.use(
        (response: any) => {
            const url: string = stripQuery(response.config?.url ?? "");
            if (ignorePaths.some((p) => url.includes(p))) return response;

            const statusCode: number = response.status ?? 0;
            const requestId = requestIdOf(response.config, response);
            const durationMs = response.config?.metadata?.startTime
                ? Date.now() - response.config.metadata.startTime
                : undefined;

            // Handle error responses that come through fulfilled handler
            // (when validateStatus: () => true is used)
            if (statusCode >= minStatus) {
                const level: LogLevel = statusCode >= 500 ? "error" : "warn";
                const name =
                    statusCode >= 500 ? "api.request.server_error" : "api.request.client_error";

                monitor.emit(name, level, {
                    requestId,
                    data: {
                        method: (response.config?.method ?? "").toUpperCase(),
                        url,
                        status_code: statusCode,
                        error: response.data?.error,
                        error_message: response.data?.error_message,
                        duration_ms: durationMs,
                    },
                });

                return response;
            }

            // Report successful requests if enabled
            if (reportSuccess && statusCode > 0) {
                monitor.info("api.request.success", {
                    requestId,
                    data: {
                        method: (response.config?.method ?? "").toUpperCase(),
                        url,
                        status_code: statusCode,
                        duration_ms: durationMs,
                    },
                });
            }

            return response;
        },
        (error: any) => {
            const url: string = stripQuery(error.config?.url ?? "");
            if (ignorePaths.some((p) => url.includes(p))) {
                return Promise.reject(error);
            }

            const durationMs = error.config?.metadata?.startTime
                ? Date.now() - error.config.metadata.startTime
                : undefined;

            // Network errors (no response — timeout, DNS failure, CORS blocked)
            if (!error.response) {
                monitor.error("api.request.network_error", {
                    requestId: requestIdOf(error.config),
                    data: {
                        method: (error.config?.method ?? "").toUpperCase(),
                        url,
                        error_code: error.code,
                        error_message: error.message,
                        duration_ms: durationMs,
                    },
                });
                return Promise.reject(error);
            }

            // HTTP errors (when validateStatus is default — throws on non-2xx)
            const statusCode: number = error.response.status ?? 0;
            const requestId = requestIdOf(error.config, error.response);

            if (statusCode >= minStatus) {
                const level: LogLevel = statusCode >= 500 ? "error" : "warn";
                const name =
                    statusCode >= 500 ? "api.request.server_error" : "api.request.client_error";

                monitor.emit(name, level, {
                    requestId,
                    data: {
                        method: (error.config?.method ?? "").toUpperCase(),
                        url,
                        status_code: statusCode,
                        error: error.response.data?.error,
                        error_message: error.response.data?.error_message,
                        duration_ms: durationMs,
                    },
                });
            }

            return Promise.reject(error);
        }
    );
}
