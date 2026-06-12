import { afterEach, describe, test, expect } from "bun:test";
import { SessionRouting } from "../../src/worker-pool/session-routing";

describe("session routing affinity", () => {
  afterEach(() => {
    SessionRouting.clear();
  });

  test("same sessionId always routes to same worker", () => {
    const workerCount = 4;
    const id = "stable-session-xyz";
    const first = SessionRouting.route(id, workerCount);
    expect(SessionRouting.route(id, workerCount)).toBe(first);
    expect(SessionRouting.route(id, workerCount)).toBe(first);
  });

  test("routes are always within [0, workerCount)", () => {
    for (let n = 1; n <= 16; n++) {
      for (let i = 0; i < 50; i++) {
        const r = SessionRouting.route(`session-${i}-n${n}`, n);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(n);
      }
    }
  });
});
