import { existsSync, statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Alarm } from "@openomni/protocol";

export interface AlarmSource {
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
  try {
    child = Bun.spawn(["/bin/sh", "-c", command], { terminal, detached: true });
  } catch (error) {
    terminal.close();
    throw error;
  }
  const settled = Promise.all([child.exited, eof.promise]).then(([code]) => {
    if (!closing) exit(code);
  });
  void settled.catch((error: Error) => failure(error));
  return {
    async close() {
      closing = true;
      if (child.exitCode === null) child.kill("SIGKILL");
      terminal.close();
      eof.resolve();
      await settled;
    },
  };
}

export function pathSource(
  spec: Extract<Alarm.Watch, { path: string }>,
  event: (content: string) => void,
  failure: (error: Error) => void,
): AlarmSource {
  const identity = () => {
    if (!existsSync(spec.path)) return null;
    const stat = statSync(spec.path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
  let previous = identity();
  const source = watch(dirname(spec.path), (_kind, name) => {
    if (name !== null && name !== basename(spec.path)) return;
    try {
      const next = identity();
      const kind = previous === null && next !== null ? "create" : "modify";
      const changed = next !== null && next !== previous;
      previous = next;
      if (changed && kind === spec.event) event(JSON.stringify({ path: spec.path, event: kind }));
    } catch (error) {
      failure(error instanceof Error ? error : new Error(String(error)));
    }
  });
  source.on("error", failure);
  return {
    close() {
      source.close();
      return Promise.resolve();
    },
  };
}
