/**
 * #1276 composition fixtures: the product choices the app injects
 * (apps/openomni/src/composition/model-selection.ts and ./parent-reply).
 * Core tests inject these to exercise the seams `ChatAgentConfig.
 * restoreModelSelection`, `SessionChatRunnerOptions.pinnedModel` and
 * `SessionRuntime.parentReply` with the shipped behavior. Kept in sync by
 * hand; #1258 replaces parent-reply with the contact contract.
 */
import type { SessionKernel } from "../../src/core/entity";
import { receivedMessages } from "../../src/core/commit";
import type { SessionRunnerResult } from "../../src/core/run";
import type { ExecutionError } from "../../src/core/failure";
import type { Executor } from "../../src/core/gate/decide";
import {
  canonicalDigest,
  Inbox,
  SessionTransition,
  type LedgerAction,
  type LedgerSession,
  type Model,
  type PlainObject,
  type PlainValue,
} from "@openomni/protocol";
import { Effect } from "effect";

function record(value: PlainValue | undefined): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Mirror of apps/openomni/src/composition/model-selection.ts#pinnedModelSelection. */
export function pinnedModelSelection(
  kernel: SessionKernel,
  sessionId: string,
  turnId: string,
): Model.Ref | undefined {
  const action = kernel.priorModelAttempt(sessionId, turnId);
  const { provider, model } = record(record(action?.intent.value).value);
  return typeof provider === "string" && typeof model === "string" ? { provider, id: model } : undefined;
}

/** Mirror of apps/openomni/src/composition/model-selection.ts#restoreModelSelection. */
export function restoreModelSelection(
  executor: Pick<Executor, "run">,
  pinned: Model.Ref | undefined,
  chain: readonly Model.Ref[],
): Effect.Effect<number, ExecutionError> {
  return Effect.suspend(() => {
  const primary = chain[0];
  if (pinned === undefined || primary === undefined) return Effect.succeed(0);
  const index = chain.findIndex(
    (model) => model.provider === pinned.provider && model.id === pinned.id,
  );
  if (index <= 0) return Effect.succeed(0);
  return executor.run(
    {
      kind: "llm",
      op: "restore_model_selection",
      intent: {
        from: { provider: pinned.provider, id: pinned.id },
        to: { provider: primary.provider, id: primary.id },
      },
      effect: { model: { provider: primary.provider, id: primary.id } },
      recovery: "local_transactional",
    },
    () => Effect.succeed({ restored: true }),
  ).pipe(Effect.map((outcome) => outcome.terminal === "executed" ? 0 : index));
  });
}

/** Mirror of apps/openomni/src/composition/parent-reply#parentReply. */
export function parentReply(
  kernel: SessionKernel,
  row: LedgerSession.Row,
  terminal: LedgerAction.Append,
  result: SessionRunnerResult,
): SessionTransition.OutboundMessage | undefined {
  if (row.parentId === null || result.kind === "waiting") return undefined;
  const original = receivedMessages(kernel, row.id).rows
    .map((item) => Inbox.MessageOrigin.safeParse(item.origin.value))
    .find((origin) => origin.success && origin.data.senderSessionId === row.parentId);
  if (original === undefined || !original.success) return undefined;
  const message = {
    messageId: `${terminal.id}:reply`,
    sourceSessionId: row.id,
    sourceActionId: terminal.id,
    destinationSessionId: row.parentId,
    requestId: original.data.sourceActionId,
    replyTo: original.data.replyTo ?? original.data.messageId,
    terminal: result.kind === "result" ? ("completed" as const) : result.kind,
    content: result.text ?? "",
  };
  return SessionTransition.OutboundMessage.parse({ ...message, digest: canonicalDigest(message) });
}
