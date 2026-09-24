import { Effect } from "effect";
import { CommitFailed, } from "./errors";
import { SessionHandleStore } from "@openomni/ledger";
import {
  canonicalDigest,
  PlainValueSchema,
  type LedgerAction,
  SessionTransition,
} from "@openomni/protocol";
import type { ResolvedSessionRuntime } from "./session-contract";
import type { SessionError } from "./errors";

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

function toolsGeneration(message: SessionTransition.OutboundMessage): number {
  const terminal = SessionHandleStore.turnTerminal(
    SessionHandleStore.actionById(message.sourceActionId),
  );
  const intent =
    terminal === undefined
      ? undefined
      : SessionHandleStore.turnIntent(SessionHandleStore.actionById(terminal.turnId));
  if (intent === undefined) throw new Error("outbound original turn is missing");
  return intent.toolsGeneration;
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
export function dispatchSessionOutbound(
  sessionId: string,
  runtime: ResolvedSessionRuntime,
  owner: string,
  fence: number,
  clock: () => number,
  releaseLease: boolean,
): Effect.Effect<void, SessionError> {
  return Effect.suspend(() => {
    const commit = (actions: LedgerAction.Append[], release: boolean) => Effect.suspend(() => {
      const row = SessionHandleStore.row(sessionId);
      return SessionHandleStore.commit({
        sessionId, owner, fence, now: clock(), expectedRevision: row.revision,
        actions, consumeInboxIds: [], state: row.state, releaseLease: release,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })), Effect.asVoid);
    });
    const dispatch = Effect.forEach(SessionHandleStore.outboundRows(sessionId), (item) => Effect.scoped(Effect.gen(function* () {
      if (item.state === "delivered") return;
      if (runtime.dispatchOutbound === undefined)
        return yield* Effect.die(new Error("outbound receiving consumer is unavailable"));
      const captured = yield* runtime.generations.capture({ sessionId, generation: toolsGeneration(item.message) });
      const receipt = yield* captured.provide(runtime.dispatchOutbound({
        message: item.message,
        authority: { owner, fence },
      })).pipe(Effect.provide(runtime.services));
      yield* commit([acknowledge(item.message, receipt, clock())], false);
    })), { discard: true });
    return releaseLease ? dispatch.pipe(Effect.onExit(() => commit([], true).pipe(Effect.orDie))) : dispatch;
  });
}
