import { PlainValueSchema } from "@openomni/protocol";
import { createCompactionPlan } from "../../src/compaction/durable";
import { createAssistantMessage } from "../../src/core/message-factory";
import type { SessionRunnerInput, SessionRunnerResult } from "../../src/session-contract";
import { foldSessionHistory } from "../../src/session-lifecycle/history";
import type { createTurnDispatcher } from "../../src/tool-dispatcher";

/**
 * Answers the turn, then compacts the prompt away behind that answer exactly
 * as the real cut records it: assistant message, then the compaction intent
 * carrying its own revert data.
 */
export async function answerThenCompact(
  executor: ReturnType<typeof createTurnDispatcher>["executor"],
  input: SessionRunnerInput,
): Promise<SessionRunnerResult> {
  const answer = createAssistantMessage("answer", "", input.sessionId);
  await executor.run(
    { kind: "message", op: "assistant", intent: { messageId: answer.info.id }, effect: {} },
    async () => PlainValueSchema.parse(answer),
  );
  const prior = foldSessionHistory(input.sessionId, input.ledger.actions?.() ?? []);
  const plan = createCompactionPlan(prior, [answer], 100);
  await executor.run(
    {
      kind: "compaction",
      op: "compact",
      intent: { trigger: "threshold" },
      effect: {},
      revertData: () => PlainValueSchema.parse(plan.record.revert),
    },
    async () => PlainValueSchema.parse({ ...plan.record, projection: plan.projection }),
  );
  return { kind: "result", text: "answer", finishReason: "stop" };
}
