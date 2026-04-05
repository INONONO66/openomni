import { describe, expect, test } from "bun:test";
import { SessionCache } from "../../src/cache/session-cache";

describe("SessionCache", () => {
  test("touching 100 sessions keeps all active", () => {
    const cache = new SessionCache();

    for (let i = 0; i < 100; i++) {
      cache.touch(`session-${i}`);
    }

    expect(cache.size).toBe(100);
    expect(cache.isActive("session-0")).toBe(true);
    expect(cache.isActive("session-99")).toBe(true);
  });

  test("touching 101st non-streaming session evicts oldest", () => {
    const cache = new SessionCache();

    for (let i = 0; i < 101; i++) {
      cache.touch(`session-${i}`);
    }

    expect(cache.size).toBe(100);
    expect(cache.isActive("session-0")).toBe(false);
    expect(cache.isActive("session-100")).toBe(true);
  });

  test("oldest streaming session is not evicted", () => {
    const cache = new SessionCache();

    cache.touch("session-0");
    cache.setStreaming("session-0", true);

    for (let i = 1; i <= 100; i++) {
      cache.touch(`session-${i}`);
    }

    expect(cache.size).toBe(100);
    expect(cache.isActive("session-0")).toBe(true);
    expect(cache.isActive("session-1")).toBe(false);
    expect(cache.isActive("session-100")).toBe(true);
  });
});
