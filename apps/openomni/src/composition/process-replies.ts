import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { SessionTransition } from "@openomni/protocol";
import { ProcessReplyReceipt } from "./process-session";

/** Transport response correlation only; durable delivery truth remains in the source action tree. */
export function createProcessReplyChannel(input: Readable, write: (line: string) => void) {
  const lines = createInterface({ input });
  const first = Promise.withResolvers<string | undefined>();
  let opened = false;
  const pending = new Map<string, {
    resolve(value: SessionTransition.Resolution): void;
    reject(error: Error): void;
  }>();
  function fail(error: Error): void {
    first.reject(error);
    for (const entry of pending.values()) entry.reject(error);
  }
  lines.on("line", (line) => {
    if (!opened) { opened = true; first.resolve(line); return; }
    try {
      const receipt = ProcessReplyReceipt.parse(JSON.parse(line));
      const entry = pending.get(receipt.inputId);
      if (entry === undefined) throw new Error("unsolicited process receiving receipt");
      if (receipt.ok) entry.resolve(receipt.resolution);
      else entry.reject(new Error(receipt.error));
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  lines.on("close", () => {
    if (!opened) first.resolve(undefined);
    for (const entry of pending.values()) entry.reject(new Error("process reply transport closed"));
  });
  lines.on("error", fail);
  return {
    first: first.promise,
    async answer(answer: SessionTransition.Answer): Promise<SessionTransition.Resolution> {
      const response = Promise.withResolvers<SessionTransition.Resolution>();
      if (pending.has(answer.inputId)) throw new Error("process reply is already in flight");
      pending.set(answer.inputId, response);
      const timer = setTimeout(() => response.reject(new Error("process receiving receipt timed out")), 30_000);
      try {
        write(JSON.stringify({ kind: "request_answer", answer }));
        return await response.promise;
      } finally { clearTimeout(timer); pending.delete(answer.inputId); }
    },
    close() { lines.close(); input.pause(); },
  };
}
