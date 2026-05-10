import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Monitor } from "./client";

const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal("fetch", mockFetch);

describe("Monitor", () => {
    let monitor: Monitor;

    beforeEach(() => {
        mockFetch.mockClear();
        monitor = new Monitor({
            service: "test-service",
            ingestUrl: "http://localhost:8030/v1/events",
            apiKey: "test-key",
            env: "test",
            flushInterval: 60000, // don't auto-flush during tests
            batchSize: 100,
            captureErrors: false,
            captureUnhandledRejections: false,
        });
    });

    afterEach(() => {
        monitor.shutdown();
    });

    it("queues events without flushing below batch size", () => {
        monitor.info("test.event", { data: { foo: "bar" } });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("flushes events as NDJSON", () => {
        monitor.info("event.one", { data: { a: 1 } });
        monitor.error("event.two", { data: { b: 2 } });
        monitor.flush();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toBe("http://localhost:8030/v1/events");
        expect(opts.headers["X-Api-Key"]).toBe("test-key");
        expect(opts.headers["Content-Type"]).toBe("application/x-ndjson");

        const lines = (opts.body as string).split("\n");
        expect(lines).toHaveLength(2);

        const event1 = JSON.parse(lines[0]);
        expect(event1.service).toBe("test-service");
        expect(event1.env).toBe("test");
        expect(event1.name).toBe("event.one");
        expect(event1.level).toBe("info");
        expect(event1.data).toEqual({ a: 1 });

        const event2 = JSON.parse(lines[1]);
        expect(event2.name).toBe("event.two");
        expect(event2.level).toBe("error");
    });

    it("includes request_id when provided", () => {
        monitor.error("api.failed", {
            requestId: "550e8400-e29b-41d4-a716-446655440000",
            data: { status_code: 500 },
        });
        monitor.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const event = JSON.parse(body);
        expect(event.request_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("persists user_id across events via setUser", () => {
        monitor.setUser("123");
        monitor.info("page.view");
        monitor.info("button.click");
        monitor.flush();

        const lines = (mockFetch.mock.calls[0][1].body as string).split("\n");
        expect(JSON.parse(lines[0]).user_id).toBe("123");
        expect(JSON.parse(lines[1]).user_id).toBe("123");
    });

    it("clearUser removes user_id", () => {
        monitor.setUser("123");
        monitor.info("with.user");
        monitor.clearUser();
        monitor.info("without.user");
        monitor.flush();

        const lines = (mockFetch.mock.calls[0][1].body as string).split("\n");
        expect(JSON.parse(lines[0]).user_id).toBe("123");
        expect(JSON.parse(lines[1]).user_id).toBe("");
    });

    it("auto-flushes when batch size is reached", () => {
        const small = new Monitor({
            service: "test",
            ingestUrl: "http://localhost/v1/events",
            apiKey: "key",
            batchSize: 3,
            flushInterval: 60000,
            captureErrors: false,
            captureUnhandledRejections: false,
        });

        small.info("one");
        small.info("two");
        expect(mockFetch).not.toHaveBeenCalled();
        small.info("three"); // triggers flush
        expect(mockFetch).toHaveBeenCalledTimes(1);
        small.shutdown();
    });

    it("does not flush when queue is empty", () => {
        monitor.flush();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sets correct timestamp format", () => {
        monitor.info("test.time");
        monitor.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const event = JSON.parse(body);
        // ISO 8601 format
        expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("supports all log levels", () => {
        monitor.debug("d");
        monitor.info("i");
        monitor.warn("w");
        monitor.error("e");
        monitor.fatal("f");
        monitor.flush();

        const lines = (mockFetch.mock.calls[0][1].body as string).split("\n");
        expect(JSON.parse(lines[0]).level).toBe("debug");
        expect(JSON.parse(lines[1]).level).toBe("info");
        expect(JSON.parse(lines[2]).level).toBe("warn");
        expect(JSON.parse(lines[3]).level).toBe("error");
        expect(JSON.parse(lines[4]).level).toBe("fatal");
    });
});
