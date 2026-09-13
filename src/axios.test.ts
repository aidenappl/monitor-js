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

    describe("validateStatus: () => true (fulfilled handler)", () => {
        it("reports 5xx responses as error level", () => {
            axios._simulateResponse({
                status: 500,
                headers: { "x-request-id": "8c1bcd3e-57dc-407b-9595-b2a98851d9a4" },
                config: {
                    method: "post",
                    url: "/team/v3.1/scraper/runs",
                    metadata: { startTime: Date.now() - 500 },
                },
                data: {
                    success: false,
                    error: "scraper_unreachable",
                    error_message: "failed to reach scraper service",
                },
            });
            monitor.flush();

            const body = mockFetch.mock.calls[0][1].body as string;
            const event = JSON.parse(body);
            expect(event.name).toBe("api.request.server_error");
            expect(event.level).toBe("error");
            expect(event.request_id).toBe("8c1bcd3e-57dc-407b-9595-b2a98851d9a4");
            expect(event.data.status_code).toBe(500);
            expect(event.data.error).toBe("scraper_unreachable");
            expect(event.data.error_message).toBe("failed to reach scraper service");
            expect(event.data.method).toBe("POST");
            expect(event.data.duration_ms).toBeTypeOf("number");
        });

        it("reports 4xx responses as warn level", () => {
            axios._simulateResponse({
                status: 401,
                headers: { "x-request-id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
                config: {
                    method: "get",
                    url: "/team/v3.1/users",
                    metadata: { startTime: Date.now() - 100 },
                },
                data: { success: false, error: "unauthorized", error_message: "token expired" },
            });
            monitor.flush();

            const body = mockFetch.mock.calls[0][1].body as string;
            const event = JSON.parse(body);
            expect(event.name).toBe("api.request.client_error");
            expect(event.level).toBe("warn");
            expect(event.data.status_code).toBe(401);
        });

        it("does not report 2xx responses by default", () => {
            axios._simulateResponse({
                status: 200,
                headers: { "x-request-id": "11111111-2222-3333-4444-555555555555" },
                config: { method: "get", url: "/team/v3.1/users", metadata: { startTime: Date.now() } },
                data: { success: true, data: [] },
            });
            monitor.flush();

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("reports 2xx responses when reportSuccess is enabled", () => {
            const monitor2 = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                flushInterval: 60000,
                captureErrors: false,
                captureUnhandledRejections: false,
            });
            const axios2 = createMockAxios();
            attachAxiosMonitor(axios2, monitor2, { reportSuccess: true });

            axios2._simulateResponse({
                status: 200,
                headers: { "x-request-id": "11111111-2222-3333-4444-555555555555" },
                config: { method: "get", url: "/team/v3.1/users", metadata: { startTime: Date.now() } },
                data: { success: true },
            });
            monitor2.flush();

            const body = mockFetch.mock.calls[0][1].body as string;
            const event = JSON.parse(body);
            expect(event.name).toBe("api.request.success");
            expect(event.level).toBe("info");
            monitor2.shutdown();
        });
    });

    describe("standard axios error handling (rejected handler)", () => {
        it("reports 5xx as error via rejected handler", async () => {
            const error = {
                response: {
                    status: 500,
                    headers: { "x-request-id": "abcdefab-1234-5678-9012-abcdefabcdef" },
                    data: { error: "internal", error_message: "something went wrong" },
                },
                config: {
                    method: "post",
                    url: "/api/action",
                    metadata: { startTime: Date.now() - 250 },
                },
            };

            await expect(axios._simulateError(error)).rejects.toBe(error);
            monitor.flush();

            const body = mockFetch.mock.calls[0][1].body as string;
            const event = JSON.parse(body);
            expect(event.name).toBe("api.request.server_error");
            expect(event.level).toBe("error");
            expect(event.request_id).toBe("abcdefab-1234-5678-9012-abcdefabcdef");
        });

        it("reports network errors when no response exists", async () => {
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

        it("reports ERR_NETWORK for connection failures", async () => {
            const error = {
                config: { method: "post", url: "/api/submit", metadata: { startTime: Date.now() - 100 } },
                code: "ERR_NETWORK",
                message: "Network Error",
            };

            await expect(axios._simulateError(error)).rejects.toBe(error);
            monitor.flush();

            const body = mockFetch.mock.calls[0][1].body as string;
            const event = JSON.parse(body);
            expect(event.name).toBe("api.request.network_error");
            expect(event.data.error_code).toBe("ERR_NETWORK");
        });
    });

    describe("ignorePaths", () => {
        it("skips ignored paths in fulfilled handler", () => {
            const monitor2 = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                flushInterval: 60000,
                captureErrors: false,
                captureUnhandledRejections: false,
            });
            const axios2 = createMockAxios();
            attachAxiosMonitor(axios2, monitor2, { ignorePaths: ["/healthcheck", "/api/health"] });

            axios2._simulateResponse({
                status: 500,
                headers: {},
                config: { method: "get", url: "/healthcheck", metadata: { startTime: Date.now() } },
                data: {},
            });
            monitor2.flush();

            expect(mockFetch).not.toHaveBeenCalled();
            monitor2.shutdown();
        });

        it("skips ignored paths in rejected handler", async () => {
            const monitor2 = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                flushInterval: 60000,
                captureErrors: false,
                captureUnhandledRejections: false,
            });
            const axios2 = createMockAxios();
            attachAxiosMonitor(axios2, monitor2, { ignorePaths: ["/api/health"] });

            const error = {
                config: { method: "get", url: "/api/health", metadata: { startTime: Date.now() } },
                code: "ECONNABORTED",
                message: "timeout",
            };

            await expect(axios2._simulateError(error)).rejects.toBe(error);
            monitor2.flush();

            expect(mockFetch).not.toHaveBeenCalled();
            monitor2.shutdown();
        });
    });

    describe("edge cases", () => {
        it("handles missing headers gracefully", () => {
            axios._simulateResponse({
                status: 503,
                headers: {},
                config: { method: "get", url: "/api/down", metadata: { startTime: Date.now() } },
                data: {},
            });
            monitor.flush();

            const body = mockFetch.mock.calls[0][1].body as string;
            const event = JSON.parse(body);
            expect(event.request_id).toBe("");
            expect(event.data.status_code).toBe(503);
        });

        it("handles missing config metadata gracefully", () => {
            axios._simulateResponse({
                status: 500,
                headers: {},
                config: { method: "get", url: "/api/broken" },
                data: { error: "oops" },
            });
            monitor.flush();

            const body = mockFetch.mock.calls[0][1].body as string;
            const event = JSON.parse(body);
            expect(event.data.duration_ms).toBeUndefined();
        });

        it("handles completely missing config", async () => {
            const error = { code: "ERR_NETWORK", message: "Network Error" };
            await expect(axios._simulateError(error)).rejects.toBe(error);
            monitor.flush();

            const body = mockFetch.mock.calls[0][1].body as string;
            const event = JSON.parse(body);
            expect(event.data.method).toBe("");
            expect(event.data.url).toBe("");
        });
    });
});

describe("attachAxiosMonitor URL privacy", () => {
    it("drops the query string and fragment from reported URLs", () => {
        mockFetch.mockClear();
        const monitor = new Monitor({
            service: "test-dashboard",
            ingestUrl: "http://localhost/v1/events",
            apiKey: "key",
            flushInterval: 60000,
            captureErrors: false,
            captureUnhandledRejections: false,
        });
        const axios = createMockAxios();
        attachAxiosMonitor(axios, monitor);

        axios._simulateResponse({
            status: 500,
            headers: {},
            data: {},
            config: { method: "get", url: "/api/users?token=abc123&page=2#frag", metadata: { startTime: Date.now() } },
        });
        monitor.flush();

        const event = JSON.parse(mockFetch.mock.calls[0][1].body as string);
        expect(event.data.url).toBe("/api/users");
        monitor.shutdown();
    });
});
