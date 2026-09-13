import { describe, it, expect } from "vitest";
import { isValidCorrelationId, newRequestId, newTraceId, newJobId } from "./ids";

describe("correlation ids", () => {
    it("accepts exactly what monitor-core accepts", () => {
        for (const ok of ["", "0123456789abcdef", "deadbeef", "ABCDEF0123456789", "550e8400-e29b-41d4-a716-446655440000"]) {
            expect(isValidCorrelationId(ok), ok).toBe(true);
        }
        for (const bad of ["req-123", "lattice-web-1", "a1b2c3", "0123456789abcdef ", "1' OR '1'='1"]) {
            expect(isValidCorrelationId(bad), bad).toBe(false);
        }
    });

    it("mints ids monitor-core accepts", () => {
        for (let i = 0; i < 500; i++) {
            for (const id of [newRequestId(), newJobId(), newTraceId()]) {
                expect(id).not.toBe("");
                expect(isValidCorrelationId(id), id).toBe(true);
            }
        }
    });
});
