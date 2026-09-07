import { statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Alarm } from "@openomni/protocol";

/** Opaque throws are normalized to a typed boundary outcome, never cast to Error. */
export class AlarmSourceError extends Error {
  constructor(
    readonly site:
      | "pty.data"
      | "pty.eof"
      | "path.observe"
      | "source.start"
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
  const terminal = new Bun.Terminal({
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
          if (code !== 0) failure(new Error("alarm PTY read failed"));
        } catch {
          failure(new AlarmSourceError("pty.eof"));
        }
      }
      eof.resolve();
    },
  });
  let child: ReturnType<typeof Bun.spawn>;
  let spawned = false;
  try {
    child = Bun.spawn(["/bin/sh", "-c", command], { terminal, detached: true });
    spawned = true;
  } finally {
    if (!spawned) terminal.close();
  }
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
        terminal.close();
        eof.resolve();
      }
      await eof.promise;
      terminal.close();
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
  event: (content: string) => void,
  failure: (error: Error) => void,
): AlarmSource {
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
        event(JSON.stringify({ path: spec.path, event: kind }));
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
