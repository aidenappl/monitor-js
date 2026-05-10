import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Monitor } from "./client";
import { attachAxiosMonitor } from "./axios";

const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal("fetch", mockFetch);

function createMockAxios() {
    const requestInterceptors: Array<(config: any) => any> = [];
    const responseInterceptors: Array<{
        onFulfilled: (response: any) => any;
        onRejected: (error: any) => any;
    }> = [];

    return {
        interceptors: {
            request: {
                use: (fn: (config: any) => any) => requestInterceptors.push(fn),
            },
            response: {
                use: (onFulfilled: any, onRejected: any) =>
                    responseInterceptors.push({ onFulfilled, onRejected }),
            },
        },
        // Helpers for testing
        _simulateRequest(config: any) {
            return requestInterceptors.reduce((c, fn) => fn(c), config);
        },
        _simulateResponse(response: any) {
            return responseInterceptors[0].onFulfilled(response);
        },
        _simulateError(error: any) {
            return responseInterceptors[0].onRejected(error);
        },
    };
}

describe("attachAxiosMonitor", () => {
    let monitor: Monitor;
    let axios: ReturnType<typeof createMockAxios>;

    beforeEach(() => {
        mockFetch.mockClear();
        monitor = new Monitor({
            service: "test-dashboard",
            ingestUrl: "http://localhost/v1/events",
            apiKey: "key",
            flushInterval: 60000,
            captureErrors: false,
            captureUnhandledRejections: false,
        });
        axios = createMockAxios();
        attachAxiosMonitor(axios, monitor);
    });

    afterEach(() => {
        monitor.shutdown();
    });

    it("stamps request with start time", () => {
        const config = axios._simulateRequest({ url: "/test" });
        expect(config.metadata.startTime).toBeTypeOf("number");
    });

    it("reports server errors (5xx) as error level", async () => {
        const error = {
            response: {
                status: 500,
                headers: { "x-request-id": "abc-123-def-456-00000000" },
                config: { method: "post", url: "/team/v3.1/scraper/runs" },
                data: { error: "scraper_failed", error_message: "connection refused" },
            },
            config: {
                method: "post",
                url: "/team/v3.1/scraper/runs",
                metadata: { startTime: Date.now() - 500 },
            },
        };

        await expect(axios._simulateError(error)).rejects.toBe(error);
        monitor.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const event = JSON.parse(body);
        expect(event.name).toBe("api.request.server_error");
        expect(event.level).toBe("error");
        expect(event.request_id).toBe("abc-123-def-456-00000000");
        expect(event.data.status_code).toBe(500);
        expect(event.data.error_message).toBe("connection refused");
        expect(event.data.method).toBe("POST");
    });

    it("reports client errors (4xx) as warn level", async () => {
        const error = {
            response: {
                status: 401,
                headers: { "x-request-id": "req-uuid-here-1234-567890" },
                config: { method: "get", url: "/team/v3.1/users" },
                data: { error: "unauthorized", error_message: "token expired" },
            },
            config: {
                method: "get",
                url: "/team/v3.1/users",
                metadata: { startTime: Date.now() - 100 },
            },
        };

        await expect(axios._simulateError(error)).rejects.toBe(error);
        monitor.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const event = JSON.parse(body);
        expect(event.name).toBe("api.request.client_error");
        expect(event.level).toBe("warn");
    });

    it("reports network errors when no response", async () => {
        const error = {
            config: { method: "get", url: "/api/data", metadata: { startTime: Date.now() - 5000 } },
            code: "ECONNABORTED",
            message: "timeout of 10000ms exceeded",
        };

        await expect(axios._simulateError(error)).rejects.toBe(error);
        monitor.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const event = JSON.parse(body);
        expect(event.name).toBe("api.request.network_error");
        expect(event.level).toBe("error");
        expect(event.data.error_code).toBe("ECONNABORTED");
        expect(event.data.error_message).toBe("timeout of 10000ms exceeded");
    });

    it("ignores paths in ignorePaths", async () => {
        const monitor2 = new Monitor({
            service: "test",
            ingestUrl: "http://localhost/v1/events",
            apiKey: "key",
            flushInterval: 60000,
            captureErrors: false,
            captureUnhandledRejections: false,
        });
        const axios2 = createMockAxios();
        attachAxiosMonitor(axios2, monitor2, { ignorePaths: ["/healthcheck"] });

        const error = {
            response: {
                status: 500,
                headers: {},
                config: { method: "get", url: "/healthcheck" },
                data: {},
            },
            config: { method: "get", url: "/healthcheck", metadata: { startTime: Date.now() } },
        };

        await expect(axios2._simulateError(error)).rejects.toBe(error);
        monitor2.flush();

        // No events should have been flushed
        expect(mockFetch).not.toHaveBeenCalled();
        monitor2.shutdown();
    });
});
