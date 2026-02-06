/// <reference types="bun" />
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilesystemWatcher,
  type FileEvent,
  type WatcherConfig,
} from "../../src/trigger/watcher";

const baseConfig: WatcherConfig = {
  debounceMs: 40,
  recursive: false,
  includePatterns: [],
  excludePatterns: [],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("FilesystemWatcher", () => {
  let tempDir: string;
  let watcher: FilesystemWatcher | null;
  let events: FileEvent[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "watcher-test-"));
    events = [];
    watcher = new FilesystemWatcher(baseConfig, (event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    watcher?.clearAll();
    watcher = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const createWatcher = (overrides: Partial<WatcherConfig> = {}) => {
    watcher?.clearAll();
    events = [];
    watcher = new FilesystemWatcher(
      { ...baseConfig, ...overrides },
      (event) => {
        events.push(event);
      },
    );
    return watcher;
  };

  it("watch() adds path to watched paths", () => {
    watcher!.watch(tempDir);
    expect(watcher!.getWatchedPaths()).toContain(tempDir);
  });

  it("isWatching() returns true/false correctly", () => {
    expect(watcher!.isWatching(tempDir)).toBe(false);
    watcher!.watch(tempDir);
    expect(watcher!.isWatching(tempDir)).toBe(true);
  });

  it("unwatch() removes path and stops watching", async () => {
    watcher!.watch(tempDir);
    watcher!.unwatch(tempDir);
    expect(watcher!.isWatching(tempDir)).toBe(false);
    const filePath = join(tempDir, "stopped.txt");
    await sleep(20);
    writeFileSync(filePath, "no-event");
    await sleep(baseConfig.debounceMs + 40);
    expect(events).toHaveLength(0);
  });

  it("clearAll() removes all watchers", () => {
    const otherDir = join(tempDir, "child");
    mkdirSync(otherDir);
    watcher!.watch(tempDir);
    watcher!.watch(otherDir);
    expect(watcher!.getWatchedPaths()).toHaveLength(2);
    watcher!.clearAll();
    expect(watcher!.getWatchedPaths()).toHaveLength(0);
  });

  it("getWatchedPaths() returns array of paths", () => {
    const otherDir = join(tempDir, "nested");
    mkdirSync(otherDir);
    watcher!.watch(tempDir);
    watcher!.watch(otherDir);
    const watched = watcher!.getWatchedPaths();
    expect(watched).toContain(tempDir);
    expect(watched).toContain(otherDir);
  });

  it("file events are emitted after debounce period", async () => {
    createWatcher({ debounceMs: 80 });
    const filePath = join(tempDir, "debounce.txt");
    const start = Date.now();
    (watcher as any).handleEvent(filePath, "change");
    await sleep(30);
    expect(events).toHaveLength(0);
    await sleep(120);
    const match = events.find((event) => event.path === filePath);
    expect(match).toBeDefined();
    expect(match!.timestamp).toBeGreaterThanOrEqual(start + 80);
  });

  it("pattern matching includes correct files", async () => {
    createWatcher({ includePatterns: ["include.txt"] });
    const filePath = join(tempDir, "include.txt");
    (watcher as any).handleEvent(filePath, "change");
    await sleep(baseConfig.debounceMs + 40);
    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe(filePath);
  });

  it("pattern matching excludes correct files", async () => {
    createWatcher({ excludePatterns: ["exclude.txt"] });
    const filePath = join(tempDir, "exclude.txt");
    (watcher as any).handleEvent(filePath, "change");
    await sleep(baseConfig.debounceMs + 40);
    expect(events).toHaveLength(0);
  });

  it("multiple watch() calls for same path are idempotent", () => {
    watcher!.watch(tempDir);
    watcher!.watch(tempDir);
    expect(watcher!.getWatchedPaths()).toHaveLength(1);
    expect(watcher!.isWatching(tempDir)).toBe(true);
  });

  it("event has correct shape (path, event, timestamp)", async () => {
    const filePath = join(tempDir, "shape.txt");
    const start = Date.now();
    (watcher as any).handleEvent(filePath, "rename");
    await sleep(baseConfig.debounceMs + 40);
    const match = events.find((event) => event.path === filePath);
    expect(match).toBeDefined();
    expect(match!.path).toBe(filePath);
    expect(match!.event).toBe("created");
    expect(typeof match!.timestamp).toBe("number");
    expect(match!.timestamp).toBeGreaterThanOrEqual(start);
  });
});
