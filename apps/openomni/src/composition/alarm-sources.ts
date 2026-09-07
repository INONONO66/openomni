import { statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Alarm } from "@openomni/protocol";

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
      } catch (error) {
        failure(error instanceof Error ? error : new Error(String(error)));
      }
    },
    exit(_terminal, code) {
      if (!closing) {
        try {
          frame(decoder.end());
          if (pending !== "") line(pending);
          pending = "";
          if (code !== 0) failure(new Error("alarm PTY read failed"));
        } catch (error) {
          failure(error instanceof Error ? error : new Error(String(error)));
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
      await Promise.all([child.exited, eof.promise]);
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
  // Bun's process.kill reports EPERM for some already-reaped negative PIDs on
  // Darwin. The platform kill utility preserves ESRCH versus permission errors.
  const signal = Bun.spawn(["/bin/kill", "-KILL", "--", `-${pid}`], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  const [code, error] = await Promise.all([signal.exited, new Response(signal.stderr).text()]);
  if (code !== 0 && !error.includes("No such process"))
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
    } catch (error) {
      failure(error instanceof Error ? error : new Error(String(error)));
    }
  }
  const source = watch(dirname(spec.path), (_kind, name) => {
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
