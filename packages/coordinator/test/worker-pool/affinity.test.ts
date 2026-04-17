import { describe, test, expect } from "bun:test";
import { sessionRouting } from "../../src/worker-pool/session-routing.js";

describe("session routing affinity", () => {
  test("same sessionId always routes to same worker", () => {
    const workerCount = 4;
    const id = "stable-session-xyz";
    const first = sessionRouting.route(id, workerCount);
    expect(sessionRouting.route(id, workerCount)).toBe(first);
    expect(sessionRouting.route(id, workerCount)).toBe(first);
  });

  test("routes are always within [0, workerCount)", () => {
    for (let n = 1; n <= 16; n++) {
      for (let i = 0; i < 50; i++) {
        const r = sessionRouting.route(`session-${i}-n${n}`, n);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(n);
      }
    }
  });
});
