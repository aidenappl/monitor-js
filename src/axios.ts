import type { Monitor } from "./client";

interface AxiosResponse {
    status: number;
    headers: Record<string, string>;
    config: { method?: string; url?: string };
    data?: { error_message?: string; error?: string };
}

interface AxiosError {
    response?: AxiosResponse;
    config?: { method?: string; url?: string; metadata?: { startTime?: number } };
    code?: string;
    message?: string;
}

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
 * Attaches Monitor interceptors to an Axios instance.
 * Automatically reports API failures with request_id correlation.
 */
export function attachAxiosMonitor(
    axiosInstance: AxiosInstance,
    monitor: Monitor,
    opts?: AxiosMonitorOptions
): void {
    const minStatus = opts?.minStatus ?? 400;
    const reportSuccess = opts?.reportSuccess ?? false;
    const ignorePaths = opts?.ignorePaths ?? [];

    // Stamp request start time
    axiosInstance.interceptors.request.use((config: any) => {
        config.metadata = { startTime: Date.now() };
        return config;
    });

    axiosInstance.interceptors.response.use(
        (response: any) => {
            if (!reportSuccess) return response;

            const url = response.config?.url ?? "";
            if (ignorePaths.some((p) => url.includes(p))) return response;

            const durationMs = response.config?.metadata?.startTime
                ? Date.now() - response.config.metadata.startTime
                : undefined;

            const requestId = response.headers?.["x-request-id"] ?? "";

            monitor.info("api.request.success", {
                requestId,
                data: {
                    method: (response.config?.method ?? "").toUpperCase(),
                    url,
                    status_code: response.status,
                    duration_ms: durationMs,
                },
            });

            return response;
        },
        (error: AxiosError) => {
            const url = error.config?.url ?? "";
            if (ignorePaths.some((p) => url.includes(p))) {
                return Promise.reject(error);
            }

            const statusCode = error.response?.status ?? 0;
            const requestId = error.response?.headers?.["x-request-id"] ?? "";
            const durationMs = error.config?.metadata?.startTime
                ? Date.now() - error.config.metadata.startTime
                : undefined;

            // Network errors (no response at all)
            if (!error.response) {
                monitor.error("api.request.network_error", {
                    requestId,
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

            // HTTP errors
            if (statusCode >= minStatus) {
                const level = statusCode >= 500 ? "error" : "warn";
                const name =
                    statusCode >= 500 ? "api.request.server_error" : "api.request.client_error";

                monitor.emit(name, level as any, {
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
