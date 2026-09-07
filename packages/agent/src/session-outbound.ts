import { SessionHandleStore } from "@openomni/ledger";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import {
  canonicalDigest,
  PlainValueSchema,
  type LedgerAction,
  SessionTransition,
} from "@openomni/protocol";
import type { SessionRuntime } from "./session-contract";
import { requireCommit } from "./session-record";

export function outboundOpen(
  message: SessionTransition.OutboundMessage,
  at: number,
): LedgerAction.Append {
  return {
    id: `${message.sourceActionId}:outbound`,
    parentId: message.sourceActionId,
    sessionId: message.sourceSessionId,
    kind: "outbound",
    intent: { encodingVersion: 1, value: { op: "open", message: PlainValueSchema.parse(message) } },
    effect: {
      encodingVersion: 1,
      value: {
        outbound: {
          message: PlainValueSchema.parse(message),
          state: "pending",
          destinationReceipt: null,
        },
      },
    },
    ts: at,
    irreversible: true,
  };
}

function policyGeneration(message: SessionTransition.OutboundMessage): number {
  const actions = SessionHandleStore.tree(message.sourceSessionId);
  const terminal = SessionHandleStore.turnTerminal(
    actions.find((action) => action.id === message.sourceActionId),
  );
  const intent =
    terminal === undefined
      ? undefined
      : SessionHandleStore.turnIntent(actions.find((action) => action.id === terminal.turnId));
  if (intent === undefined) throw new Error("outbound original turn is missing");
  return intent.policyGeneration;
}

function acknowledge(
  message: SessionTransition.OutboundMessage,
  receipt: LedgerAction.Receipt,
  at: number,
): LedgerAction.Append {
  const effect = receipt.action.effect.value;
  const answer =
    effect !== null && typeof effect === "object" && !Array.isArray(effect)
      ? SessionTransition.Answer.safeParse(effect.answer)
      : undefined;
  const payload =
    answer?.success === true && answer.data.outbound !== undefined
      ? PlainValueSchema.parse(answer.data.outbound)
      : receipt.action.intent.value;
  if (
    receipt.action.sessionId !== message.destinationSessionId ||
    canonicalDigest(payload) !== canonicalDigest(PlainValueSchema.parse(message))
  ) {
    throw new Error("outbound destination receipt does not match its recorded payload");
  }
  return {
    id: `${message.messageId}:ack`,
    parentId: `${message.sourceActionId}:outbound`,
    sessionId: message.sourceSessionId,
    kind: "outbound",
    intent: { encodingVersion: 1, value: { op: "ack", messageId: message.messageId } },
    effect: {
      encodingVersion: 1,
      value: {
        outbound: {
          message: PlainValueSchema.parse(message),
          state: "delivered",
          destinationReceipt: { id: receipt.action.id, revision: receipt.revision },
        },
      },
    },
    ts: at,
    irreversible: true,
  };
}

/** Drains recorded source obligations. It never seals again or writes a destination session. */
export async function dispatchSessionOutbound(
  sessionId: string,
  runtime: SessionRuntime,
  owner: string,
  fence: number,
  clock: () => number,
  pinPolicy: (generation: number) => CompiledPolicySnapshot,
  releaseLease: boolean,
): Promise<void> {
  const failures: Error[] = [];
  const commit = (actions: LedgerAction.Append[], release: boolean) => {
    const row = SessionHandleStore.row(sessionId);
    requireCommit(
      SessionHandleStore.commit({
        sessionId,
        owner,
        fence,
        now: clock(),
        expectedRevision: row.revision,
        actions,
        consumeInboxIds: [],
        state: row.state,
        releaseLease: release,
      }),
    );
  };
  try {
    for (const item of SessionHandleStore.outboundRows(sessionId)) {
      if (item.state === "delivered") continue;
      if (runtime.dispatchOutbound === undefined)
        throw new Error("outbound receiving consumer is unavailable");
      const receipt = await runtime.dispatchOutbound({
        message: item.message,
        authority: { owner, fence },
        policy: pinPolicy(policyGeneration(item.message)),
      });
      commit([acknowledge(item.message, receipt, clock())], false);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  }
  if (releaseLease) {
    try {
      commit([], true);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "outbound dispatch and source lease release failed");
}
