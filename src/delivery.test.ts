import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Monitor } from "./client";
import type { MonitorConfig } from "./types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** Lets every pending fetch promise chain run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function newMonitor(extra: Partial<MonitorConfig> = {}): Monitor {
    return new Monitor({
        service: "delivery-test",
        ingestUrl: "http://localhost/v1/events",
        apiKey: "key",
        flushInterval: 60000,
        batchSize: 1000,
        captureErrors: false,
        captureUnhandledRejections: false,
        ...extra,
    });
}

function eventsIn(call: unknown[]): Array<Record<string, any>> {
    return ((call[1] as { body: string }).body).split("\n").map((l) => JSON.parse(l));
}

describe("delivery", () => {
    let monitor: Monitor;

    beforeEach(() => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValue({ ok: true, status: 200 });
    });

    afterEach(() => {
        monitor?.shutdown();
    });

    it("counts a delivered batch", async () => {
        monitor = newMonitor();
        monitor.info("a");
        monitor.info("b");
        monitor.flush();
        await settle();
        expect(monitor.stats()).toMatchObject({ enqueued: 2, flushed: 2, dropped: 0, queued: 0 });
    });

    it("isolates a malformed event instead of losing its whole batch", async () => {
        const accepted: string[] = [];
        mockFetch.mockImplementation(async (_url: string, opts: { body: string }) => {
            if (opts.body.includes('"name":"poison"')) return { ok: false, status: 400 };
            accepted.push(...opts.body.split("\n").map((l) => JSON.parse(l).name));
            return { ok: true, status: 200 };
        });
        monitor = newMonitor();
        for (const n of ["e0", "e1", "poison", "e3"]) monitor.info(n);
        monitor.flush();

        await vi.waitFor(() => expect(monitor.stats().flushed).toBe(3));
        expect(monitor.stats()).toMatchObject({ quarantined: 1, dropped: 1 });
        expect(accepted.sort()).toEqual(["e0", "e1", "e3"]);
    });

    it("bounds the requests spent on a batch ingest rejects wholesale", async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 400 });
        monitor = newMonitor();
        for (let i = 0; i < 64; i++) monitor.info(`e${i}`);
        monitor.flush();
        await vi.waitFor(() => expect(monitor.stats().quarantined).toBe(64));
        expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(2 * (4 * 6 + 4) + 1);
    });

    it("drops, counts and reports events when ingest refuses the API key", async () => {
        const onDrop = vi.fn();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        mockFetch.mockResolvedValue({ ok: false, status: 401 });
        monitor = newMonitor({ onDrop });

        monitor.info("a");
        monitor.info("b");
        monitor.flush();
        await settle();
        expect(monitor.stats().dropped).toBe(2);
        expect(onDrop).toHaveBeenLastCalledWith(2);

        monitor.info("c");
        monitor.flush();
        await settle();
        expect(warn).toHaveBeenCalledTimes(1); // once per instance, not per batch
        warn.mockRestore();
    });

    it("requeues on a transient failure and backs off before retrying", async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
        monitor = newMonitor();
        monitor.info("a");
        monitor.info("b");
        monitor.flush();
        await settle();
        expect(monitor.stats()).toMatchObject({ flushed: 0, dropped: 0, queued: 2 });

        mockFetch.mockClear();
        monitor.flush();
        expect(mockFetch).not.toHaveBeenCalled(); // still backing off

        (monitor as any).backoffUntil = 0; // time passes
        monitor.flush();
        await settle();
        expect(monitor.stats()).toMatchObject({ flushed: 2, queued: 0 });
    });

    it("requeues on a network error", async () => {
        mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        monitor = newMonitor();
        monitor.info("a");
        monitor.flush();
        await settle();
        expect(monitor.stats()).toMatchObject({ dropped: 0, queued: 1 });
    });

    it("ignores the backoff on the final flush", async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
        monitor = newMonitor();
        monitor.info("a");
        monitor.flush();
        await settle();

        mockFetch.mockClear();
        monitor.shutdown();
        await settle();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("asks for keepalive only when the body fits the browser's quota", () => {
        monitor = newMonitor();
        monitor.info("small");
        monitor.flush();
        expect(mockFetch.mock.calls[0][1].keepalive).toBe(true);

        monitor.info("big", { data: { blob: "x".repeat(70_000) } });
        monitor.flush();
        expect(mockFetch.mock.calls[1][1].keepalive).toBe(false);
    });

    it("shrinks an event over the per-line limit, keeping what it groups by", () => {
        monitor = newMonitor();
        monitor.error("report.render.failed", {
            data: { error: "e".repeat(10_000), path: "/reports/[id]", payload: "p".repeat(1_200_000) },
        });
        monitor.flush();
        const body = mockFetch.mock.calls[0][1].body as string;
        expect(body.length).toBeLessThanOrEqual(1_000_000);
        const ev = JSON.parse(body);
        expect(ev.data.truncated).toBe(true);
        expect(ev.data.path).toBe("/reports/[id]");
        expect(ev.data.error).toHaveLength(4096);
        expect(ev.data.payload).toBeUndefined();
    });

    it("never throws into the caller on unserializable data", () => {
        monitor = newMonitor();
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(() => {
            monitor.info("circular", { data: circular });
            monitor.flush();
        }).not.toThrow();
        expect(monitor.stats().dropped).toBe(1);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("counts events dropped by queue overflow", () => {
        const onDrop = vi.fn();
        monitor = newMonitor({ batchSize: 10_000, onDrop });
        for (let i = 0; i < 510; i++) monitor.info(`e${i}`);
        expect(monitor.stats()).toMatchObject({ enqueued: 510, dropped: 10, queued: 500 });
        expect(onDrop).toHaveBeenLastCalledWith(10);
    });

    it("normalizes level spellings monitor-core would store verbatim", () => {
        monitor = newMonitor();
        monitor.emit("a", "ERROR" as any);
        monitor.emit("b", "warning" as any);
        monitor.flush();
        const [a, b] = eventsIn(mockFetch.mock.calls[0]);
        expect(a.level).toBe("error");
        expect(b.level).toBe("warn");
    });
});

describe("correlation ids on events", () => {
    let monitor: Monitor;

    beforeEach(() => {
        mockFetch.mockReset();
        mockFetch.mockResolvedValue({ ok: true, status: 200 });
    });

    afterEach(() => monitor?.shutdown());

    it("mints a valid session job_id by default", () => {
        monitor = newMonitor();
        monitor.info("a");
        monitor.flush();
        expect(eventsIn(mockFetch.mock.calls[0])[0].job_id).toMatch(/^[0-9a-f]{16}$/);
    });

    it("clears ids monitor-core would reject and keeps them in data", () => {
        monitor = newMonitor();
        monitor.setJobId("lattice-web-1");
        const callerData = { k: 1 };
        monitor.info("x", { requestId: "req-123", traceId: "550e8400-e29b-41d4-a716-446655440000", data: callerData });
        monitor.flush();

        const ev = eventsIn(mockFetch.mock.calls[0])[0];
        expect(ev.job_id).toBe("");
        expect(ev.request_id).toBe("");
        expect(ev.trace_id).toBe("550e8400-e29b-41d4-a716-446655440000");
        expect(ev.data).toEqual({ k: 1, invalid_job_id: "lattice-web-1", invalid_request_id: "req-123" });
        expect(callerData).toEqual({ k: 1 }); // the caller's object is untouched
    });
});
