import { beforeEach, expect, test } from "bun:test";
import { SessionCache } from "../../src/cache/session-cache";

let cache: SessionCache;

beforeEach(() => {
  cache = new SessionCache();
});

test("cache miss becomes hit after touch", () => {
  expect(cache.isActive("session-1")).toBe(false);
  cache.touch("session-1");
  expect(cache.isActive("session-1")).toBe(true);
});

test("evicts oldest non-streaming session on overflow", () => {
  for (let i = 0; i < 100; i++) {
    cache.touch(`session-${i}`);
  }

  cache.touch("session-100");

  expect(cache.size).toBe(100);
  expect(cache.isActive("session-0")).toBe(false);
  expect(cache.isActive("session-100")).toBe(true);
});

test("keeps streaming session during eviction", () => {
  cache.touch("streaming-session");
  cache.setStreaming("streaming-session", true);

  for (let i = 0; i < 100; i++) {
    cache.touch(`session-${i}`);
  }

  expect(cache.isActive("streaming-session")).toBe(true);
  expect(cache.size).toBe(100);
});
