import type { PlainValue } from "@openomni/protocol";
import type { DurableExecutor, LlmAttempts } from "../../src/executor-contract";

/** Runs one recorded `llm/chat` action whose attempts all share the trivial prepare/admit shape. */
export function runChatAttempts<T extends PlainValue>(
  executor: Pick<DurableExecutor, "run" | "runAttempts">,
  body: (attempt: number) => Promise<T>,
  evidence?: LlmAttempts<T>["evidence"],
) {
  return executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent) =>
    executor.runAttempts(parent, {
      prepare: async (attempt) => ({
        request: { op: "chat", intent: { attempt }, effect: {} },
        admit: async () => undefined,
        body: () => body(attempt),
      }),
      ...(evidence === undefined ? {} : { evidence }),
    }),
  );
}
