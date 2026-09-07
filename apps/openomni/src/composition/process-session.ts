import { z } from "zod";
import { SessionTransition } from "@openomni/protocol";
import type { ProcessSessionRequest } from "../process-entry";

const Doorbell = z.object({ sessionIds: z.array(z.string().min(1)) }).strict();
const ProcessOutput = z.union([Doorbell, z.object({
  kind: z.literal("request_answer"), answer: SessionTransition.Answer,
}).strict()]);
export const ProcessReplyReceipt = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), inputId: z.string().min(1), resolution: SessionTransition.Resolution }).strict(),
  z.object({ ok: z.literal(false), inputId: z.string().min(1), error: z.string() }).strict(),
]);

/** A process is only a transport for the same durable session runner. */
export function createProcessSessionTransport(options: {
  readonly command: readonly string[];
  readonly worker: Omit<ProcessSessionRequest, "sessionId">;
  readonly committed: (sessionIds: readonly string[]) => void;
  readonly answer: (answer: SessionTransition.Answer) => Promise<SessionTransition.Resolution>;
}) {
  const children = new Map<string, { close: () => void; done: Promise<void> }>();
  async function receive(line: string, sessionId: string, write: (value: string) => void) {
    const output = ProcessOutput.parse(JSON.parse(line));
    if ("sessionIds" in output) {
      options.committed(output.sessionIds);
      return;
    }
    const answer = output.answer;
    if (answer.principal.kind !== "session" || answer.principal.principalId !== sessionId || answer.outbound?.sourceSessionId !== sessionId)
      throw new Error("process answer principal does not match its authenticated child");
    let receipt: z.infer<typeof ProcessReplyReceipt>;
    try {
      receipt = { ok: true, inputId: answer.inputId, resolution: await options.answer(answer) };
    } catch (error) {
      receipt = { ok: false, inputId: answer.inputId, error: error instanceof Error ? error.message : String(error) };
    }
    write(`${JSON.stringify(receipt)}\n`);
  }
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
              await receive(line, sessionId, value => { child.stdin.write(value); });
              end = buffer.indexOf("\n");
            }
          }
          const code = await child.exited;
          if (code !== 0) throw new Error(`session process exited ${code}: ${sessionId}`);
        } finally {
          reader.releaseLock();
          if (child.exitCode === null) child.kill();
          child.stdin.end();
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
