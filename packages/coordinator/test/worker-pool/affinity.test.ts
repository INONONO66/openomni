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

  test("100 sessions distribute across all 4 workers", () => {
    const workerCount = 4;
    const counts = new Array<number>(workerCount).fill(0);
    for (let i = 0; i < 100; i++) {
      counts[sessionRouting.route(`session-${i}`, workerCount)]++;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(10);
    }
  });

  test("different sessionIds can reach different workers", () => {
    const workerCount = 4;
    const reached = new Set<number>();
    for (let i = 0; i < 40; i++) {
      reached.add(sessionRouting.route(`varied-${i * 13 + 7}`, workerCount));
    }
    expect(reached.size).toBeGreaterThan(1);
  });
});
