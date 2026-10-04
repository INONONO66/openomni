import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Alarm } from "@openomni/protocol";
import {
  AlarmRuntimeError,
  commandSource,
  createWatchSources,
  type ArmedWatch,
  type WatchHitSend,
} from "../src/composition/watch-sources";
import { eventSignal } from "./helpers/event-signal";

// Each PTY test spawns /bin/sh under a fresh terminal; at load average 25+ that
// spawn can stall past the 5 s default (#1027). Only the failure ceiling.
const SPAWNED_PTY_MS = 15_000;

function armed(input: {
  readonly id: string;
  readonly watch: Alarm.Watch;
  readonly armSeq?: number;
  readonly occurrenceId?: string;
  readonly notifications?: number;
}): ArmedWatch {
  return {
    sessionId: "monitor-session",
    id: input.id,
    occurrence: {
      occurrenceId: input.occurrenceId ?? `occ-${input.id}-${input.armSeq ?? 1}`,
      alarmId: input.id,
      armSeq: input.armSeq ?? 1,
    },
    base: {
      spec: { watch: input.watch, policyGeneration: 1, notificationLimit: 8 },
      notifications: input.notifications ?? 0,
    },
  };
}

interface SentHit {
  readonly send: WatchHitSend;
  readonly hit: { content: string; terminal: boolean; detail: string };
  readonly notifications: number;
}

function parseHit(send: WatchHitSend): SentHit {
  const payload = JSON.parse(send.payload) as {
    notifications: number;
    hit: { content: string; terminal: boolean; detail: string };
  };
  return { send, hit: payload.hit, notifications: payload.notifications };
}

function recordingSenders() {
  const sends: WatchHitSend[] = [];
  return {
    sends,
    senders: {
      deliver: (send: WatchHitSend) => {
        sends.push(send);
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

test("command watch resends the armed occurrence per filtered line and a terminal exit summary", async () => {
  const sends: WatchHitSend[] = [];
  const terminal = eventSignal<WatchHitSend>("terminal watch hit", SPAWNED_PTY_MS);
  const sources = createWatchSources(
    {
      deliver: (send) => {
        sends.push(send);
        if (JSON.parse(send.payload).hit.terminal === true) terminal.resolve(send);
        return Promise.resolve();
      },
    },
    { clock: () => 41_000, failure: (_id, error) => terminal.reject(error) },
  );
  await sources.install(
    armed({
      id: "watch-cmd",
      armSeq: 3,
      watch: {
        command: "printf 'keep:1\\nskip\\nkeep:2\\n'; exit 3",
        filter: "^keep:",
        description: "filtered lines",
        timeout_ms: 1000,
      },
    }),
  );
  await terminal.promise;
  await sources.closeAll();
  const hits = sends.map(parseHit);
  expect(hits.map((entry) => [entry.hit.detail, entry.hit.content])).toEqual([
    ["line:1", "keep:1"],
    ["line:3", "keep:2"],
    // A nonzero exit carries the command's last line so a watch that dies at birth names its cause.
    ["exit:3", JSON.stringify({ watchId: "watch-cmd", reason: "exit", exitCode: 3, output: "keep:2" })],
  ]);
  // Every resend carries the SAME armed occurrence: the chain is the dedupe.
  expect(
    sends.every(
      (send) =>
        send.occurrenceId === "occ-watch-cmd-3" &&
        send.alarmId === "watch-cmd" &&
        send.armSeq === 3 &&
        send.purpose === "monitor.hit" &&
        send.sourceKey === "monitor" &&
        send.fireAt === 41_000,
    ),
  ).toBe(true);
});

test("path watch fires on observed modification with the stat-identity transport detail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watch-sources-path-"));
  const path = join(directory, "target");
  writeFileSync(path, "before");
  const { sends, senders } = recordingSenders();
  const sources = createWatchSources(senders, { clock: () => 7, failure: () => undefined });
  try {
    await sources.install(
      armed({
        id: "watch-path",
        watch: { path, event: "modify", description: "path modify", persistent: true },
      }),
    );
    writeFileSync(path, "after with more bytes");
    sources.observe("watch-path");
    await sources.close("watch-path");
    expect(sends).toHaveLength(1);
    const entry = parseHit(sends[0] as WatchHitSend);
    expect(entry.send).toMatchObject({ alarmId: "watch-path", purpose: "monitor.hit" });
    expect(entry.hit).toMatchObject({
      terminal: false,
      content: JSON.stringify({ path, event: "modify" }),
    });
    expect(entry.hit.detail.startsWith("path:modify:")).toBe(true);
  } finally {
    await sources.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refresh swaps the armed occurrence without touching the native handle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watch-sources-refresh-"));
  const path = join(directory, "target");
  writeFileSync(path, "v1");
  const { sends, senders } = recordingSenders();
  const sources = createWatchSources(senders, { clock: () => 0, failure: () => undefined });
  try {
    const first = armed({
      id: "watch-swap",
      armSeq: 1,
      watch: { path, event: "modify", description: "swap", persistent: true },
    });
    await sources.install(first);
    writeFileSync(path, "v2 grows the file");
    sources.observe("watch-swap");
    // Re-arm: the chain's new occurrence and spent budget ride the holder.
    expect(
      sources.refresh(
        armed({
          id: "watch-swap",
          armSeq: 2,
          notifications: 1,
          watch: { path, event: "modify", description: "swap", persistent: true },
        }),
      ),
    ).toBe(true);
    writeFileSync(path, "v3 grows the file even more");
    sources.observe("watch-swap");
    await sources.close("watch-swap");
    expect(sends.map((send) => [send.occurrenceId, send.armSeq])).toEqual([
      ["occ-watch-swap-1", 1],
      ["occ-watch-swap-2", 2],
    ]);
    expect(sends.map((send) => parseHit(send).notifications)).toEqual([0, 1]);
    // A refresh for an uninstalled id reports false: the caller installs.
    expect(
      sources.refresh(
        armed({
          id: "unknown",
          watch: { path, event: "modify", description: "none", persistent: true },
        }),
      ),
    ).toBe(false);
  } finally {
    await sources.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("path watch native callback observes a created target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "watch-sources-create-"));
  const path = join(directory, "target");
  const created = eventSignal<WatchHitSend>("native path create", SPAWNED_PTY_MS);
  const sources = createWatchSources(
    {
      deliver: (send) => {
        created.resolve(send);
        return Promise.resolve();
      },
    },
    { clock: () => 0, failure: (_id, error) => created.reject(error) },
  );
  try {
    await sources.install(
      armed({
        id: "watch-create",
        watch: { path, event: "create", description: "native create", persistent: true },
      }),
    );
    writeFileSync(path, "created");
    const send = await created.promise;
    const entry = parseHit(send);
    expect(send.alarmId).toBe("watch-create");
    expect(entry.hit).toMatchObject({
      content: JSON.stringify({ path, event: "create" }),
      terminal: false,
    });
    expect(entry.hit.detail.startsWith("path:create:")).toBe(true);
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
  const summary = eventSignal<WatchHitSend>("source_error summary", SPAWNED_PTY_MS);
  const sources = createWatchSources(
    {
      deliver: (send) => {
        if (JSON.parse(send.payload).hit.terminal === true) summary.resolve(send);
        return Promise.resolve();
      },
    },
    { clock: () => 0, failure: (id, error) => failures.push([id, error]) },
  );
  try {
    await sources.install(
      armed({
        id: "watch-fault",
        armSeq: 2,
        watch: { path, event: "modify", description: "faulting stat", persistent: true },
      }),
    );
    chmodSync(directory, 0o000);
    sources.observe("watch-fault");
    const send = await summary.promise;
    const entry = parseHit(send);
    expect(send).toMatchObject({ alarmId: "watch-fault", occurrenceId: "occ-watch-fault-2" });
    expect(entry.hit).toMatchObject({
      terminal: true,
      detail: "source_error",
      content: JSON.stringify({ watchId: "watch-fault", reason: "source_error", exitCode: null }),
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
  const { sends, senders } = recordingSenders();
  const wake = eventSignal<WatchHitSend>("terminal wake", SPAWNED_PTY_MS);
  const scripted = scriptedTerminal();
  const sources = createWatchSources(
    {
      deliver: (send) => {
        wake.resolve(send);
        return senders.deliver(send);
      },
    },
    {
      clock: () => 0,
      failure: () => undefined,
      machines: { get: () => ({ pty: scripted.pty }) },
    },
  );
  try {
    await sources.install(
      armed({
        id: "watch-terminal",
        watch: { machine: "m-1", session: "qa", filter: "WAKE-7342", description: "terminal", persistent: true },
      }),
    );
    // install returned => subscribed: the baseline read already happened.
    expect(scripted.reads()).toBeGreaterThanOrEqual(1);
    const fired = parseHit(await wake.promise);
    expect(fired.send).toMatchObject({ alarmId: "watch-terminal", occurrenceId: "occ-watch-terminal-1" });
    expect(fired.hit).toEqual({ content: "WAKE-7342", terminal: false, detail: "pty:1" });
    // The retained matching line before subscription never fired.
    expect(sends.filter((send) => send.alarmId === "watch-terminal")).toHaveLength(1);
  } finally {
    await sources.closeAll();
    for (const resolve of scripted.hanging)
      resolve({ status: "ok", data: new Uint8Array(), cursor: "cx", truncated: false });
  }
});

test("a terminal watch without a machines plane refuses at install", async () => {
  const { senders } = recordingSenders();
  const sources = createWatchSources(senders, { clock: () => 0, failure: () => undefined });
  await expect(
    sources.install(
      armed({
        id: "watch-bodyless",
        watch: { machine: "m-1", session: "qa", description: "terminal", persistent: true },
      }),
    ),
  ).rejects.toThrow("alarm source failed at terminal.open");
});

test("a rejecting deliver routes through the failure callback with the watch id", async () => {
  const failed = eventSignal<[string, Error]>("send failure", SPAWNED_PTY_MS);
  const sources = createWatchSources(
    { deliver: () => Promise.reject(new Error("entity send refused")) },
    { clock: () => 0, failure: (id, error) => failed.resolve([id, error]) },
  );
  await sources.install(
    armed({
      id: "watch-refused",
      watch: { command: "printf 'ONE\\n'; exit 0", description: "refused sends", persistent: true },
    }),
  );
  const [id, error] = await failed.promise;
  await sources.closeAll();
  expect(id).toBe("watch-refused");
  expect(error.message).toBe("entity send refused");
});

test("reinstalling a watch id replaces the previous handle before new occurrences", async () => {
  const sends: WatchHitSend[] = [];
  const secondExit = eventSignal<WatchHitSend>("second handle exit", SPAWNED_PTY_MS);
  const sources = createWatchSources(
    {
      deliver: (send) => {
        sends.push(send);
        if (JSON.parse(send.payload).hit.terminal === true && send.armSeq === 2)
          secondExit.resolve(send);
        return Promise.resolve();
      },
    },
    { clock: () => 0, failure: (_id, error) => secondExit.reject(error) },
  );
  await sources.install(
    armed({
      id: "watch-replace",
      armSeq: 1,
      watch: { command: "read hold", description: "first handle", persistent: true },
    }),
  );
  await sources.install(
    armed({
      id: "watch-replace",
      armSeq: 2,
      watch: { command: "printf 'E2\\n'; exit 0", description: "second handle", persistent: true },
    }),
  );
  await secondExit.promise;
  await sources.closeAll();
  // The first holder was closed by the reinstall: closing emits no occurrence,
  // so every recorded send names the second armed occurrence.
  expect(sends.length).toBeGreaterThanOrEqual(2);
  expect(sends.every((send) => send.armSeq === 2)).toBe(true);
});
