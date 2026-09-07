import { z } from "zod";
import type { ProcessSessionRequest } from "../process-entry";

const Doorbell = z.object({ sessionIds: z.array(z.string().min(1)) }).strict();

/** A process is only a transport for the same durable session runner. */
export function createProcessSessionTransport(options: {
  readonly command: readonly string[];
  readonly worker: Omit<ProcessSessionRequest, "sessionId">;
  readonly committed: (sessionIds: readonly string[]) => void;
}) {
  const children = new Map<string, { close: () => void; done: Promise<void> }>();
  return {
    wake(sessionId: string): Promise<void> {
      const existing = children.get(sessionId);
      if (existing !== undefined) return existing.done;
      const child = Bun.spawn([...options.command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      child.stdin.write(`${JSON.stringify({ ...options.worker, sessionId })}\n`);
      child.stdin.end();
      const done = (async () => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const frame = await reader.read();
            if (frame.done) break;
            buffer += decoder.decode(frame.value, { stream: true });
            let end = buffer.indexOf("\n");
            while (end >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              options.committed(Doorbell.parse(JSON.parse(line)).sessionIds);
              end = buffer.indexOf("\n");
            }
          }
          const code = await child.exited;
          if (code !== 0) throw new Error(`session process exited ${code}: ${sessionId}`);
        } finally {
          reader.releaseLock();
          children.delete(sessionId);
        }
      })();
      children.set(sessionId, { close: () => child.kill(), done });
      return done;
    },
    async close(): Promise<void> {
      const active = [...children.values()];
      for (const child of active) child.close();
      await Promise.allSettled(active.map((child) => child.done));
    },
  };
}
