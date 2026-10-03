import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlarmRuntimeError,
  commandSource,
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
    sessionId: "monitor-session",
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
  expect(timeouts).toEqual([
    { sessionId: "monitor-session", watchId: "watch-cmd", epoch: 3, fireAt: 42_000 },
  ]);
  expect(fires.map((fire) => [fire.sourceKey, fire.content])).toEqual([
    ["line:3:1", "keep:1"],
    ["line:3:3", "keep:2"],
    ["exit:3", JSON.stringify({ watchId: "watch-cmd", epoch: 3, reason: "exit", exitCode: 3, output: "keep:2" })],
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
      sessionId: "monitor-session",
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

test("path watch native callback observes a created target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watch-sources-create-"));
  const path = join(directory, "target");
  const created = eventSignal<WatchFire>("native path create", SPAWNED_PTY_MS);
  const sources = createWatchSources(
    {
      watchFired: (fire) => {
        created.resolve(fire);
        return Promise.resolve();
      },
      watchTimeout: () => Promise.resolve(),
    },
    { clock: () => 0, failure: (_id, error) => created.reject(error) },
  );
  try {
    await sources.install({
      sessionId: "monitor-session",
      id: "watch-create",
      epoch: 1,
      watch: { path, event: "create", description: "native create", persistent: true },
    });
    writeFileSync(path, "created");
    const fire = await created.promise;
    expect(fire).toMatchObject({
      watchId: "watch-create",
      content: JSON.stringify({ path, event: "create" }),
      terminal: false,
    });
    expect(fire.sourceKey.startsWith("path:create:")).toBe(true);
  } finally {
    await sources.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The stderr each process tool fails with (exit 1); `/bin/kill` still kills the group so the held shell exits. */
interface ProcessToolFailures {
  readonly kill: string;
  readonly ps?: string;
}

/** Holds one command, then closes it while the process tools fail as declared. */
function closeUnderFailingProcessTools(failing: ProcessToolFailures) {
  const failures: Error[] = [];
  const reported = Promise.withResolvers<Error>();
  const source = commandSource("read hold", () => undefined, () => undefined, (error) => {
    failures.push(error);
    reported.resolve(error);
  });
  const spawn = Bun.spawn;
  const failing_ = (stderr: string, before = "") => ["/bin/sh", "-c", `${before}printf '${stderr}\\n' >&2; exit 1`];
  const failingSpawn = new Proxy(spawn, {
    apply(
      target,
      thisArg: typeof Bun,
      args: Parameters<typeof Bun.spawn>,
    ): ReturnType<typeof Bun.spawn> {
      const [command, options] = args;
      if (!Array.isArray(command)) return Reflect.apply(target, thisArg, args);
      if (command[0] === "/bin/kill")
        return Reflect.apply(target, thisArg, [failing_(failing.kill, `/bin/kill -KILL -- ${command.at(-1)}; `), options]);
      if (command[0] === "ps" && failing.ps !== undefined)
        return Reflect.apply(target, thisArg, [failing_(failing.ps), options]);
      return Reflect.apply(target, thisArg, args);
    },
  });
  Reflect.set(Bun, "spawn", failingSpawn);
  const closed = source.close().finally(() => Reflect.set(Bun, "spawn", spawn));
  return { closed, failures, reported: reported.promise };
}

test("command close accepts EPERM after readback finds no live group members", async () => {
  const { closed, failures } = closeUnderFailingProcessTools({ kill: "Operation not permitted" });
  await closed;
  expect(failures).toEqual([]);
});

test.each([
  [
    "a kill failure that is neither ESRCH nor EPERM",
    { kill: "kill: unexpected failure" },
    /^alarm process group \d+ termination failed: kill: unexpected failure$/,
  ],
  [
    "an EPERM whose process readback fails",
    { kill: "Operation not permitted", ps: "ps: readback unavailable" },
    /^alarm process-group readback failed: ps: readback unavailable$/,
  ],
])("command close reports %s as a named process-group failure", async (_case, failing, message) => {
  const { closed, reported } = closeUnderFailingProcessTools(failing);
  // Both the caller's close and the source's failure port receive the one typed error.
  const [rejection, failure] = await Promise.all([closed.then(() => undefined, (error: Error) => error), reported]);
  expect(rejection).toBe(failure);
  expect(failure).toMatchObject({ name: "AlarmProcessGroupError", message: expect.stringMatching(message) });
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
      sessionId: "monitor-session",
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

type ScriptedView = { status: "ok"; data: Uint8Array; cursor: string; truncated: boolean };
/** A scripted pty door: retained history before subscribe, then one live line. */
function scriptedTerminal() {
  const hanging: ((view: ScriptedView) => void)[] = [];
  let reads = 0;
  return {
    hanging,
    reads: () => reads,
    pty: {
      open: () => Promise.resolve({ status: "ok", cursor: "c0" } as const),
      read: (_name: string, options?: { cursor?: string; waitMs?: number }) => {
        reads += 1;
        // Subscribe baseline: everything retained before the watch existed —
        // including bytes that MATCH the filter — and a cursor past it all.
        if (options?.cursor === "c0")
          return Promise.resolve({
            status: "ok",
            data: Buffer.from("scrollback WAKE-7342 already on screen\n"),
            cursor: "c1",
            truncated: false,
          } as ScriptedView);
        // First drain round: the one new matching line, delivered once.
        if (options?.cursor === "c1")
          return Promise.resolve({
            status: "ok",
            data: Buffer.from("WAKE-7342\n"),
            cursor: "c2",
            truncated: false,
          } as ScriptedView);
        // Later rounds block on the daemon's output gate.
        return new Promise<ScriptedView>((resolve) => hanging.push(resolve));
      },
    },
  };
}

test("a terminal watch drains by cursor: retained bytes never fire, one new line is one fire", async () => {
  const { fires, senders } = recordingSenders();
  const wake = eventSignal<WatchFire>("terminal wake", SPAWNED_PTY_MS);
  const scripted = scriptedTerminal();
  const sources = createWatchSources(
    {
      ...senders,
      watchFired: (fire) => {
        wake.resolve(fire);
        return senders.watchFired(fire);
      },
    },
    {
      clock: () => 0,
      failure: () => undefined,
      machines: { get: () => ({ pty: scripted.pty }) },
    },
  );
  try {
    await sources.install({
      sessionId: "monitor-session",
      id: "watch-terminal",
      epoch: 1,
      watch: { machine: "m-1", session: "qa", filter: "WAKE-7342", description: "terminal", persistent: true },
    });
    // install returned => subscribed: the baseline read already happened.
    expect(scripted.reads()).toBeGreaterThanOrEqual(1);
    const fired = await wake.promise;
    expect(fired).toMatchObject({
      watchId: "watch-terminal",
      epoch: 1,
      sourceKey: "pty:1:1",
      content: "WAKE-7342",
      terminal: false,
    });
    // The retained matching line before subscription never fired.
    expect(fires.filter((fire) => fire.watchId === "watch-terminal")).toHaveLength(1);
  } finally {
    await sources.closeAll();
    for (const resolve of scripted.hanging)
      resolve({ status: "ok", data: new Uint8Array(), cursor: "cx", truncated: false });
  }
});

test("a terminal watch without a machines plane refuses at create", async () => {
  const { senders } = recordingSenders();
  const sources = createWatchSources(senders, { clock: () => 0, failure: () => undefined });
  await expect(
    sources.install({
      sessionId: "monitor-session",
      id: "watch-bodyless",
      epoch: 1,
      watch: { machine: "m-1", session: "qa", description: "terminal", persistent: true },
    }),
  ).rejects.toThrow("alarm source failed at terminal.open");
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
    sessionId: "monitor-session",
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
    sessionId: "monitor-session",
    id: "watch-epoch",
    epoch: 1,
    watch: { command: "read hold", description: "first epoch", persistent: true },
  });
  await sources.install({
    sessionId: "monitor-session",
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
