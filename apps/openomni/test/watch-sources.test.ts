import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlarmRuntimeError,
  createWatchSources,
  type WatchFire,
  type WatchTimeoutArm,
} from "../src/composition/watch-sources";
import { eventSignal } from "./helpers/event-signal";

// Each PTY test spawns /bin/sh under a fresh terminal; at load average 25+ that
// spawn can stall past the 5 s default (#1027). Only the failure ceiling.
const SPAWNED_PTY_MS = 15_000;

function recordingSenders() {
  const fires: WatchFire[] = [];
  const timeouts: WatchTimeoutArm[] = [];
  return {
    fires,
    timeouts,
    senders: {
      watchFired: (fire: WatchFire) => {
        fires.push(fire);
        return Promise.resolve();
      },
      watchTimeout: (arm: WatchTimeoutArm) => {
        timeouts.push(arm);
        return Promise.resolve();
      },
    },
  };
}

test("watch-sources composition refuses a missing PTY builtin with the typed runtime error", () => {
  const terminal = Bun.Terminal;
  Reflect.set(Bun, "Terminal", undefined);
  try {
    expect(() =>
      createWatchSources(recordingSenders().senders, {
        clock: () => 0,
        failure: () => undefined,
      }),
    ).toThrow(AlarmRuntimeError);
  } finally {
    Reflect.set(Bun, "Terminal", terminal);
  }
});

test("command watch sends filtered lines in source order and a terminal exit summary", async () => {
  const { fires, timeouts, senders } = recordingSenders();
  const terminal = eventSignal<WatchFire>("terminal watch fire", SPAWNED_PTY_MS);
  const sources = createWatchSources(
    {
      ...senders,
      watchFired: (fire) => {
        fires.push(fire);
        if (fire.terminal) terminal.resolve(fire);
        return Promise.resolve();
      },
    },
    { clock: () => 41_000, failure: (_id, error) => terminal.reject(error) },
  );
  await sources.install({
    id: "watch-cmd",
    epoch: 3,
    watch: {
      command: "printf 'keep:1\\nskip\\nkeep:2\\n'; exit 3",
      filter: "^keep:",
      description: "filtered lines",
      timeout_ms: 1000,
    },
  });
  const summary = await terminal.promise;
  await sources.closeAll();
  expect(timeouts).toEqual([{ watchId: "watch-cmd", epoch: 3, fireAt: 42_000 }]);
  expect(fires.map((fire) => [fire.sourceKey, fire.content])).toEqual([
    ["line:3:1", "keep:1"],
    ["line:3:3", "keep:2"],
    ["exit:3", JSON.stringify({ watchId: "watch-cmd", epoch: 3, reason: "exit", exitCode: 3 })],
  ]);
  expect(summary.terminal).toBe(true);
  expect(fires.every((fire) => fire.watchId === "watch-cmd" && fire.epoch === 3)).toBe(true);
});

test("path watch fires on observed modification with the stat-identity source key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watch-sources-path-"));
  const path = join(directory, "target");
  writeFileSync(path, "before");
  const { fires, timeouts, senders } = recordingSenders();
  const sources = createWatchSources(senders, {
    clock: () => 0,
    failure: () => undefined,
  });
  try {
    await sources.install({
      id: "watch-path",
      epoch: 1,
      watch: { path, event: "modify", description: "path modify", persistent: true },
    });
    writeFileSync(path, "after with more bytes");
    sources.observe("watch-path");
    await sources.close("watch-path");
    expect(timeouts).toEqual([]);
    expect(fires).toHaveLength(1);
    const fire = fires[0];
    expect(fire).toMatchObject({
      watchId: "watch-path",
      epoch: 1,
      terminal: false,
      content: JSON.stringify({ path, event: "modify" }),
    });
    expect(fire?.sourceKey.startsWith("path:modify:")).toBe(true);
  } finally {
    await sources.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a faulting path source sends a terminal source_error summary and the typed failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watch-sources-fault-"));
  // Dropping the directory's permissions after install makes the observe-time
  // `statSync` throw EACCES: the deterministic source fault.
  const path = join(directory, "target");
  writeFileSync(path, "present");
  const failures: [string, Error][] = [];
  const summary = eventSignal<WatchFire>("source_error summary", SPAWNED_PTY_MS);
  const sources = createWatchSources(
    {
      watchFired: (fire) => {
        if (fire.terminal) summary.resolve(fire);
        return Promise.resolve();
      },
      watchTimeout: () => Promise.resolve(),
    },
    { clock: () => 0, failure: (id, error) => failures.push([id, error]) },
  );
  try {
    await sources.install({
      id: "watch-fault",
      epoch: 2,
      watch: { path, event: "modify", description: "faulting stat", persistent: true },
    });
    chmodSync(directory, 0o000);
    sources.observe("watch-fault");
    const fired = await summary.promise;
    expect(fired).toMatchObject({
      watchId: "watch-fault",
      epoch: 2,
      sourceKey: "source_error:2",
      terminal: true,
      content: JSON.stringify({
        watchId: "watch-fault",
        epoch: 2,
        reason: "source_error",
        exitCode: null,
      }),
    });
    expect(failures).toMatchObject([
      ["watch-fault", { name: "AlarmSourceError", site: "path.observe" }],
    ]);
  } finally {
    chmodSync(directory, 0o755);
    await sources.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a rejecting watchFired send routes through the failure callback with the watch id", async () => {
  const failed = eventSignal<[string, Error]>("send failure", SPAWNED_PTY_MS);
  const sources = createWatchSources(
    {
      watchFired: () => Promise.reject(new Error("entity send refused")),
      watchTimeout: () => Promise.resolve(),
    },
    { clock: () => 0, failure: (id, error) => failed.resolve([id, error]) },
  );
  await sources.install({
    id: "watch-refused",
    epoch: 1,
    watch: { command: "printf 'ONE\\n'; exit 0", description: "refused sends", persistent: true },
  });
  const [id, error] = await failed.promise;
  await sources.closeAll();
  expect(id).toBe("watch-refused");
  expect(error.message).toBe("entity send refused");
});

test("reinstalling a watch id replaces the previous epoch's handle before new occurrences", async () => {
  const { fires, senders } = recordingSenders();
  const secondExit = eventSignal<WatchFire>("second epoch exit", SPAWNED_PTY_MS);
  const sources = createWatchSources(
    {
      ...senders,
      watchFired: (fire) => {
        fires.push(fire);
        if (fire.terminal && fire.epoch === 2) secondExit.resolve(fire);
        return Promise.resolve();
      },
    },
    { clock: () => 0, failure: (_id, error) => secondExit.reject(error) },
  );
  await sources.install({
    id: "watch-epoch",
    epoch: 1,
    watch: { command: "read hold", description: "first epoch", persistent: true },
  });
  await sources.install({
    id: "watch-epoch",
    epoch: 2,
    watch: { command: "printf 'E2\\n'; exit 0", description: "second epoch", persistent: true },
  });
  await secondExit.promise;
  await sources.closeAll();
  // The first epoch's holder was closed by the reinstall: closing emits no
  // occurrence, so every recorded fire belongs to epoch 2.
  expect(fires.length).toBeGreaterThanOrEqual(2);
  expect(fires.every((fire) => fire.epoch === 2)).toBe(true);
});
