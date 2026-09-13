/**
 * monitor-core's correlation-id rule (structs.correlationIDRegex), verbatim.
 *
 * Ingest validates job_id, request_id and trace_id against it and rejects the
 * WHOLE request when any line fails — so one malformed id, passed through
 * unchecked, loses every event batched with it.
 */
const CORRELATION_ID =
    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{8,64})$/;

/**
 * Whether monitor-core would accept `id` as a job_id, request_id or trace_id.
 * The empty string is valid: the server skips empty ids.
 */
export function isValidCorrelationId(id: string): boolean {
    return id === "" || CORRELATION_ID.test(id);
}

function randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (c && typeof c.getRandomValues === "function") {
        c.getRandomValues(out);
        return out;
    }
    // Node 18 has no global crypto. Correlation ids need uniqueness, not secrecy.
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A request_id monitor-core accepts: 16 hex characters. */
export function newRequestId(): string {
    return hex(randomBytes(8));
}

/** A job_id monitor-core accepts: 16 hex characters. */
export function newJobId(): string {
    return hex(randomBytes(8));
}

/** A trace_id monitor-core accepts: a hyphenated UUID v4. */
export function newTraceId(): string {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    const h = hex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
