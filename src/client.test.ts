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
        monitor.setJobId("0123456789abcdef");
        monitor.info("event.one");
        monitor.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const event = JSON.parse(body);
        expect(event.job_id).toBe("0123456789abcdef");
    });

    it("allows per-event userId override", () => {
        monitor.setUser("global-user");
        monitor.info("override.event", { userId: "specific-user" });
        monitor.flush();

        const body = mockFetch.mock.calls[0][1].body as string;
        const event = JSON.parse(body);
        expect(event.user_id).toBe("specific-user");
    });

    it("does not drop the queue when global fetch is undefined", () => {
        const savedFetch = globalThis.fetch;
        // Simulate a runtime without global fetch (e.g. Node <18).
        (globalThis as any).fetch = undefined;
        try {
            monitor.info("event.one", { data: { a: 1 } });
            monitor.info("event.two", { data: { b: 2 } });
            monitor.flush();
            // Events must be retained since there is nothing to ship them with.
            expect((monitor as any).queue).toHaveLength(2);
        } finally {
            (globalThis as any).fetch = savedFetch;
        }
        // Once fetch is back, the retained events flush successfully.
        monitor.flush();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const lines = (mockFetch.mock.calls[0][1].body as string).split("\n");
        expect(lines).toHaveLength(2);
    });

    describe("Node process handlers", () => {
        it("captures uncaughtException via the registered process handler", () => {
            const m = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                batchSize: 100,
                flushInterval: 60000,
            });

            const err = new Error("boom from node");
            (m as any).nodeExceptionHandler(err);
            m.flush();

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const event = JSON.parse((mockFetch.mock.calls[0][1].body as string).split("\n")[0]);
            expect(event.name).toBe("client.error.uncaught");
            expect(event.level).toBe("error");
            expect(event.data.message).toBe("boom from node");
            m.shutdown();
        });

        it("captures unhandledRejection via the registered process handler", () => {
            const m = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                batchSize: 100,
                flushInterval: 60000,
            });

            (m as any).nodeRejectionHandler(new Error("rejected in node"));
            m.flush();

            const event = JSON.parse((mockFetch.mock.calls[0][1].body as string).split("\n")[0]);
            expect(event.name).toBe("client.error.unhandled_rejection");
            expect(event.data.message).toBe("rejected in node");
            m.shutdown();
        });

        it("omits path for Node handlers, which have no location", () => {
            const m = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                batchSize: 100,
                flushInterval: 60000,
            });

            (m as any).nodeExceptionHandler(new Error("server-side boom"));
            m.flush();

            const event = JSON.parse((mockFetch.mock.calls[0][1].body as string).split("\n")[0]);
            expect(event.data.path).toBeUndefined();
            m.shutdown();
        });

        it("registers a real process listener that emits on emitted events", () => {
            const m = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                batchSize: 100,
                flushInterval: 60000,
            });

            // Emit a genuine Node process event; the installed handler should catch it.
            const nodeProcess = (globalThis as any).process as {
                emit(event: string, ...args: unknown[]): boolean;
                listenerCount(event: string): number;
            };
            nodeProcess.emit("uncaughtException", new Error("via process.emit"));
            m.flush();

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const event = JSON.parse((mockFetch.mock.calls[0][1].body as string).split("\n")[0]);
            expect(event.name).toBe("client.error.uncaught");
            expect(event.data.message).toBe("via process.emit");

            // shutdown() must remove the process listener it installed.
            const before = nodeProcess.listenerCount("uncaughtException");
            m.shutdown();
            expect(nodeProcess.listenerCount("uncaughtException")).toBe(before - 1);
        });

        it("respects ignoreErrors in the Node handler", () => {
            const m = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                batchSize: 100,
                flushInterval: 60000,
                captureErrors: false,
                captureUnhandledRejections: false,
                ignoreErrors: ["ignore me"],
            });

            (m as any).nodeExceptionHandler(new Error("ignore me please"));
            m.flush();
            expect(mockFetch).not.toHaveBeenCalled();
            m.shutdown();
        });
    });

    describe("ignoreErrors", () => {
        it("drops uncaught errors matching a string pattern", () => {
            const m = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                batchSize: 100,
                flushInterval: 60000,
                captureErrors: false,
                captureUnhandledRejections: false,
                ignoreErrors: ["opts is not defined"],
            });

            (m as any).errorHandler({
                message: "Uncaught ReferenceError: opts is not defined",
                filename: "",
                lineno: 10,
                colno: 42,
                error: { stack: "ReferenceError: opts is not defined\n at ..." },
            });
            (m as any).errorHandler({
                message: "Some real error we care about",
                filename: "app.js",
                lineno: 1,
                colno: 1,
                error: { stack: "Error: real\n at ..." },
            });
            m.flush();

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const body = mockFetch.mock.calls[0][1].body as string;
            const events = body.split("\n").map((l) => JSON.parse(l));
            expect(events).toHaveLength(1);
            expect(events[0].data.message).toBe("Some real error we care about");
            m.shutdown();
        });

        it("drops unhandled rejections matching a RegExp pattern", () => {
            const m = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                batchSize: 100,
                flushInterval: 60000,
                captureErrors: false,
                captureUnhandledRejections: false,
                ignoreErrors: [/Cannot read properties of undefined \(reading 'getInitialProps'\)/],
            });

            (m as any).rejectionHandler({
                reason: { message: "Cannot read properties of undefined (reading 'getInitialProps')", stack: "TypeError: ..." },
            });
            (m as any).rejectionHandler({
                reason: { message: "Network timeout", stack: "Error: timeout\n at ..." },
            });
            m.flush();

            const body = mockFetch.mock.calls[0][1].body as string;
            const events = body.split("\n").map((l) => JSON.parse(l));
            expect(events).toHaveLength(1);
            expect(events[0].data.message).toBe("Network timeout");
            m.shutdown();
        });

        it("matches patterns against the stack trace as well as the message", () => {
            const m = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                batchSize: 100,
                flushInterval: 60000,
                captureErrors: false,
                captureUnhandledRejections: false,
                ignoreErrors: [/cloudflareinsights\.com/],
            });

            (m as any).errorHandler({
                message: "Some generic message",
                filename: "",
                lineno: 1,
                colno: 1,
                error: { stack: "at https://static.cloudflareinsights.com/beacon.min.js/...:1:1" },
            });
            m.flush();

            expect(mockFetch).not.toHaveBeenCalled();
            m.shutdown();
        });

        it("captures all errors when ignoreErrors is empty", () => {
            const m = new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                batchSize: 100,
                flushInterval: 60000,
                captureErrors: false,
                captureUnhandledRejections: false,
            });

            (m as any).errorHandler({
                message: "Anything",
                filename: "",
                lineno: 1,
                colno: 1,
                error: { stack: "..." },
            });
            m.flush();

            expect(mockFetch).toHaveBeenCalledTimes(1);
            m.shutdown();
        });
    });

    describe("path capture", () => {
        // Regression: browser error handlers never read window.location, so every
        // client error arrived at Monitor with an empty path and there was no way
        // to tell which route it happened on.
        const withLocation = (href: string, fn: () => void) => {
            const url = new URL(href);
            vi.stubGlobal("window", {
                location: url,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            });
            try {
                fn();
            } finally {
                vi.unstubAllGlobals();
                vi.stubGlobal("fetch", mockFetch);
            }
        };

        const newMonitor = () =>
            new Monitor({
                service: "test",
                ingestUrl: "http://localhost/v1/events",
                apiKey: "key",
                batchSize: 100,
                flushInterval: 60000,
                captureErrors: false,
                captureUnhandledRejections: false,
            });

        it("records the route an uncaught error happened on", () => {
            withLocation("https://trailblaze.to/blog/some-post", () => {
                const m = newMonitor();
                (m as any).errorHandler({
                    message: "boom",
                    filename: "app.js",
                    lineno: 1,
                    colno: 1,
                    error: { stack: "Error: boom" },
                });
                m.flush();

                const event = JSON.parse(
                    (mockFetch.mock.calls[0][1].body as string).split("\n")[0],
                );
                expect(event.data.path).toBe("/blog/some-post");
                m.shutdown();
            });
        });

        it("records the route an unhandled rejection happened on", () => {
            withLocation("https://trailblaze.to/terms", () => {
                const m = newMonitor();
                (m as any).rejectionHandler({ reason: new Error("nope") });
                m.flush();

                const event = JSON.parse(
                    (mockFetch.mock.calls[0][1].body as string).split("\n")[0],
                );
                expect(event.data.path).toBe("/terms");
                m.shutdown();
            });
        });

        it("excludes query strings and hashes, which can carry personal data", () => {
            withLocation("https://trailblaze.to/unsubscribe?email=someone@example.com#tok", () => {
                const m = newMonitor();
                (m as any).errorHandler({
                    message: "boom",
                    filename: "app.js",
                    lineno: 1,
                    colno: 1,
                    error: { stack: "Error: boom" },
                });
                m.flush();

                const body = mockFetch.mock.calls[0][1].body as string;
                const event = JSON.parse(body.split("\n")[0]);
                expect(event.data.path).toBe("/unsubscribe");
                expect(body).not.toContain("someone@example.com");
            });
        });
    });
});
