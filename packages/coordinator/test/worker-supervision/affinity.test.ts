import { describe, test, expect } from "bun:test";
import { createSessionRouting } from "../../src/worker-supervision/session-routing";

describe("session routing affinity", () => {
  test("same sessionId always routes to same worker", () => {
    const routing = createSessionRouting();
    const workerCount = 4;
    const id = "stable-session-xyz";
    const first = routing.route(id, workerCount);
    expect(routing.route(id, workerCount)).toBe(first);
    expect(routing.route(id, workerCount)).toBe(first);
  });

  test("routes are always within [0, workerCount)", () => {
    const routing = createSessionRouting();
    for (let n = 1; n <= 16; n++) {
      for (let i = 0; i < 50; i++) {
        const r = routing.route(`session-${i}-n${n}`, n);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(n);
      }
    }
  });
});
