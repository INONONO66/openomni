import { statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Alarm } from "@openomni/protocol";

/**
 * Watch plane over the Session entity (W5.2, plan §1 F2): this module owns the
 * native OS handles (PTY, fs watcher). Every occurrence is sent as a
 * `WatchFired` entity message and every timed watch arms one `WatchTimeout`
 * DeliverAt message; durable dedupe is the chain's committed occurrence id,
 * never cancelled storage.
 */

export class AlarmRuntimeError extends Error {
  readonly requiredVersion = ">=1.4.0";

  constructor() {
    super("Alarm monitoring requires Bun >=1.4.0 with Bun.Terminal support");
    this.name = "AlarmRuntimeError";
  }
}

export function assertAlarmRuntime(): void {
  if (Bun.Terminal === undefined || !Bun.semver.satisfies(Bun.version, ">=1.4.0"))
    throw new AlarmRuntimeError();
}

/** Opaque throws are normalized to a typed boundary outcome, never cast to Error. */
export class AlarmSourceError extends Error {
  constructor(
    readonly site:
      | "pty.data"
      | "pty.eof"
      | "path.observe"
      | "source.start"
      | "source.close"
      | "bus.scan"
      | "timer.scan",
  ) {
    super(`alarm source failed at ${site}`);
    this.name = "AlarmSourceError";
  }
}

export interface AlarmSource {
  observe?(): void;
  close(): Promise<void>;
}

export function commandSource(
  command: string,
  line: (content: string) => void,
  exit: (code: number) => void,
  failure: (error: Error) => void,
): AlarmSource {
  assertAlarmRuntime();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let closing = false;
  const eof = Promise.withResolvers<void>();
  function frame(text: string) {
    pending += text;
    let boundary = pending.indexOf("\n");
    while (boundary !== -1) {
      const content = pending.slice(0, boundary).replace(/\r$/, "");
      pending = pending.slice(boundary + 1);
      line(content);
      boundary = pending.indexOf("\n");
    }
  }
  // This terminal belongs to one child, not a reusable Terminal instance. Bun
  // then closes the parent's slave descriptor on child exit so EOF can arrive.
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    detached: true,
    terminal: {
      data(_terminal, bytes) {
        if (closing) return;
        try {
          frame(decoder.write(bytes));
        } catch {
          failure(new AlarmSourceError("pty.data"));
        }
      },
      exit(_terminal, code) {
        if (!closing) {
          try {
            frame(decoder.end());
            if (pending !== "") line(pending);
            pending = "";
            // Linux reports last-slave hangup as EIO (Bun code 1). Accept it
            // only after the child exited; a live child's read error stays fatal.
            const hungUp = code === 1 && (child.exitCode !== null || child.signalCode !== null);
            if (code !== 0 && !hungUp) failure(new Error("alarm PTY read failed"));
          } catch {
            failure(new AlarmSourceError("pty.eof"));
          }
        }
        eof.resolve();
      },
    },
  });
  const terminal = child.terminal;
  let shutdown: Promise<void> | undefined;
  function terminate() {
    shutdown ??= (async () => {
      // The shell can exit before its children. Kill its group even then, before
      // awaiting PTY EOF; waiting for EOF first lets HUP-ignoring descendants hang.
      await killCommandGroup(child.pid);
      await child.exited;
      // Cancellation has no remaining output to drain. Retire the master after
      // the owned group was signalled and the leader reaped, even if Bun omits EOF.
      if (closing) {
        terminal?.close();
        eof.resolve();
      }
      await eof.promise;
      terminal?.close();
    })();
    return shutdown;
  }
  const settled = child.exited.then(async (code) => {
    await terminate();
    if (!closing) exit(code);
  });
  void settled.catch((error: Error) => failure(error));
  return {
    async close() {
      closing = true;
      await terminate();
      await settled;
    },
  };
}

async function killCommandGroup(pid: number): Promise<void> {
  // Keep signalling the group after leader exit. Darwin can report EPERM for
  // zombie-only groups; accept that only after an authoritative process readback.
  const signal = Bun.spawn(["/bin/kill", "-KILL", "--", `-${pid}`], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  const [code, error] = await Promise.all([signal.exited, new Response(signal.stderr).text()]);
  if (code === 0 || error.includes("No such process")) return;
  if (error.includes("Operation not permitted")) {
    const probe = Bun.spawn(["ps", "-axo", "pgid=,stat="], { stdout: "pipe", stderr: "pipe" });
    const [status, processes, diagnostic] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`alarm process-group readback failed: ${diagnostic.trim()}`);
    const alive = processes.split("\n").some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !state?.startsWith("Z");
    });
    if (!alive) return;
  }
  throw new Error(`alarm process group ${pid} termination failed: ${error.trim()}`);
}

export function pathSource(
  spec: Extract<Alarm.Watch, { path: string }>,
  event: (content: string, identity: string) => void,
  failure: (error: Error) => void,
): AlarmSource {
  // The stat identity is the transport occurrence key; `previous` is only the
  // physical snapshot that classifies create/modify. Durable dedupe is the ledger's.
  const identity = () => {
    const stat = statSync(spec.path, { bigint: true, throwIfNoEntry: false });
    return stat === undefined ? null : `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
  let previous = identity();
  let closed = false;
  function observe() {
    if (closed) return;
    try {
      const next = identity();
      const kind = previous === null && next !== null ? "create" : "modify";
      if (next !== null && next !== previous && kind === spec.event)
        event(JSON.stringify({ path: spec.path, event: kind }), `${kind}:${next}`);
      // Do not advance the observation cursor if committing the event failed.
      previous = next;
    } catch {
      failure(new AlarmSourceError("path.observe"));
    }
  }
  const source = watch(dirname(spec.path), { recursive: true }, (_kind, name) => {
    if (name === null || name === basename(spec.path)) observe();
  });
  source.on("error", failure);
  return {
    observe,
    close() {
      closed = true;
      source.close();
      return Promise.resolve();
    },
  };
}

export interface WatchFire {
  /** The session whose chain owns this watch (entity address). */
  readonly sessionId: string;
  readonly watchId: string;
  readonly epoch: number;
  /** Transport occurrence captured at the source (line slot, path stat identity, exit). */
  readonly sourceKey: string;
  readonly content: string;
  readonly terminal: boolean;
}

export interface WatchTimeoutArm {
  readonly sessionId: string;
  readonly watchId: string;
  readonly epoch: number;
  readonly fireAt: number;
}

/** Entity-message senders, implemented over the Session entity client. */
export interface WatchSenders {
  watchFired(fire: WatchFire): Promise<void>;
  watchTimeout(arm: WatchTimeoutArm): Promise<void>;
}

export interface WatchSourceSpec {
  readonly sessionId: string;
  readonly id: string;
  readonly epoch: number;
  readonly watch: Alarm.Watch;
}

export interface WatchSources {
  install(spec: WatchSourceSpec): Promise<void>;
  /** Reconciles a path watch's stat identity outside its native callback. */
  observe(id: string): void;
  close(id: string): Promise<void>;
  closeAll(): Promise<void>;
}

interface Holder {
  source: AlarmSource;
  /** Per-watch send serialization: occurrences leave in source order. */
  tail: Promise<void>;
}

export function createWatchSources(
  senders: WatchSenders,
  options: {
    readonly clock: () => number;
    readonly failure: (watchId: string, error: Error) => void;
  },
): WatchSources {
  // The watch plane owns the boot-time runtime requirement: composing it on a
  // Bun without PTY support is a typed refusal, not a first-watch surprise.
  assertAlarmRuntime();
  const holders = new Map<string, Holder>();

  function enqueue(holder: Holder, fire: WatchFire): void {
    holder.tail = holder.tail
      .then(() => senders.watchFired(fire))
      .catch((error: Error) => options.failure(fire.watchId, error));
  }

  function summary(
    spec: WatchSourceSpec,
    reason: "exit" | "source_error",
    exitCode: number | null,
  ) {
    return {
      sessionId: spec.sessionId,
      watchId: spec.id,
      epoch: spec.epoch,
      sourceKey: `${reason}:${spec.epoch}`,
      content: JSON.stringify({ watchId: spec.id, epoch: spec.epoch, reason, exitCode }),
      terminal: true,
    } satisfies WatchFire;
  }

  function sourceFailure(spec: WatchSourceSpec, holder: Holder, error: Error): void {
    enqueue(holder, summary(spec, "source_error", null));
    options.failure(spec.id, error);
  }

  function startCommand(
    spec: WatchSourceSpec,
    watchSpec: Extract<Alarm.Watch, { command: string }>,
    holder: Holder,
  ): AlarmSource {
    const filter = watchSpec.filter === undefined ? undefined : new RegExp(watchSpec.filter);
    let lines = 0;
    return commandSource(
      watchSpec.command,
      (content) => {
        lines += 1;
        if (filter === undefined || filter.test(content))
          enqueue(holder, {
            sessionId: spec.sessionId,
            watchId: spec.id,
            epoch: spec.epoch,
            sourceKey: `line:${spec.epoch}:${lines}`,
            content,
            terminal: false,
          });
      },
      (code) => enqueue(holder, summary(spec, "exit", code)),
      (error) => sourceFailure(spec, holder, error),
    );
  }

  function startPath(
    spec: WatchSourceSpec,
    watchSpec: Extract<Alarm.Watch, { path: string }>,
    holder: Holder,
  ): AlarmSource {
    return pathSource(
      watchSpec,
      (content, identity) =>
        enqueue(holder, {
          sessionId: spec.sessionId,
          watchId: spec.id,
          epoch: spec.epoch,
          sourceKey: `path:${identity}`,
          content,
          terminal: false,
        }),
      (error) => sourceFailure(spec, holder, error),
    );
  }

  async function close(id: string): Promise<void> {
    const holder = holders.get(id);
    if (holder === undefined) return;
    holders.delete(id);
    await holder.source.close();
    await holder.tail;
  }

  return {
    async install(spec) {
      // Reinstall replaces the previous epoch's handle before any new occurrence.
      await close(spec.id);
      if (spec.watch.timeout_ms !== undefined)
        await senders.watchTimeout({
          sessionId: spec.sessionId,
          watchId: spec.id,
          epoch: spec.epoch,
          fireAt: options.clock() + spec.watch.timeout_ms,
        });
      const holder: Holder = {
        source: { close: () => Promise.resolve() },
        tail: Promise.resolve(),
      };
      holder.source =
        "command" in spec.watch
          ? startCommand(spec, spec.watch, holder)
          : startPath(spec, spec.watch, holder);
      holders.set(spec.id, holder);
    },
    observe(id) {
      holders.get(id)?.source.observe?.();
    },
    close,
    async closeAll() {
      await Promise.all([...holders.keys()].map(close));
    },
  };
}
