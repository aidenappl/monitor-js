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
            flushInterval: 60000,
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

    it("flushes events as NDJSON with correct headers", () => {
        monitor.info("event.one", { data: { a: 1 } });
        monitor.error("event.two", { data: { b: 2 } });
        monitor.flush();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toBe("http://localhost:8030/v1/events");
        expect(opts.headers["X-Api-Key"]).toBe("test-key");
        expect(opts.headers["Content-Type"]).toBe("application/x-ndjson");
        expect(opts.keepalive).toBe(true);

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
        small.info("three");
        expect(mockFetch).toHaveBeenCalledTimes(1);
        small.shutdown();
    });

    it("does not flush when queue is empty", () => {
        monitor.flush();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sets correct ISO 8601 timestamp", () => {
        monitor.info("test.time");
        monitor.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const event = JSON.parse(body);
        expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
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

    it("drops events silently after shutdown", () => {
        monitor.shutdown();
        mockFetch.mockClear();
        monitor.info("should.be.dropped");
        monitor.flush();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("caps queue at MAX_QUEUE_SIZE to prevent memory leaks", () => {
        const small = new Monitor({
            service: "test",
            ingestUrl: "http://localhost/v1/events",
            apiKey: "key",
            batchSize: 10000, // never auto-flush
            flushInterval: 60000,
            captureErrors: false,
            captureUnhandledRejections: false,
        });

        for (let i = 0; i < 600; i++) {
            small.emit("flood.event", "info", { data: { i } });
        }
        small.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const lines = body.split("\n");
        expect(lines.length).toBeLessThanOrEqual(500);
        small.shutdown();
    });

    it("persists job_id across events via setJobId", () => {
        monitor.setJobId("job-uuid-123");
        monitor.info("event.one");
        monitor.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const event = JSON.parse(body);
        expect(event.job_id).toBe("job-uuid-123");
    });

    it("allows per-event userId override", () => {
        monitor.setUser("global-user");
        monitor.info("override.event", { userId: "specific-user" });
        monitor.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const event = JSON.parse(body);
        expect(event.user_id).toBe("specific-user");
    });
});
