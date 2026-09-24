import { SessionHandleStore, type CommitReceipt, type LedgerError } from "@openomni/ledger";
import { Effect } from "effect";
import {
  canonicalDigest,
  PlainValueSchema,
  SessionTurn,
  type FoldCheckpoint,
  type LedgerAction,
  type LedgerSession,
} from "@openomni/protocol";
import {
  foldHistoryState,
  foldSessionHistory,
  readHistoryCheckpoint,
} from "./session-lifecycle/history";
import { pinCompactionAction } from "./compaction/successor";
import { foldCheckpointAction } from "./session-record";

/** Synchronous decoration preserves durable admission's existing suspension schedule. */
export function commitFoldBatch(
  input: LedgerSession.Commit,
): Effect.Effect<CommitReceipt, LedgerError> {
  return Effect.gen(function* () {
    const checkpoint = readHistoryCheckpoint(input.sessionId, input.expectedRevision);
    const incoming = input.actions.filter((action) => action.kind !== "fold.checkpoint").length;
    if (checkpoint.nonCheckpointActions + incoming < 256 && !input.actions.some(needsProjection))
      return yield* SessionHandleStore.commit(input);
    const hydrated = checkpoint.hydrate();
    let state = hydrated.state;
    let count = hydrated.nonCheckpointActions;
    const actions: LedgerAction.Append[] = [];
    for (const draft of input.actions) {
      const sourceRevision = input.expectedRevision + actions.length;
      const action = pinCompactionAction(
        pinContext(draft, state, sourceRevision),
        state,
        sourceRevision,
      );
      actions.push(action);
      const ordinal = input.expectedRevision + actions.length;
      state = foldHistoryState(
        input.sessionId,
        [{ ...action, ordinal, prevHash: "", actionHash: "" }],
        state,
      );
      if (action.kind !== "fold.checkpoint") count += 1;
      const effect = action.effect.value;
      const compaction =
        action.kind === "compaction" &&
        effect !== null &&
        typeof effect === "object" &&
        !Array.isArray(effect) &&
        effect.phase === "result" &&
        effect.terminal === "executed";
      if (count < 256 && !compaction) continue;
      actions.push(
        foldCheckpointAction({
          sessionId: input.sessionId,
          parentId: action.id,
          revision: ordinal,
          at: input.now,
          reason: compaction ? "compaction" : "interval",
          state,
        }),
      );
      count = 0;
    }
    if (actions.length === 0 && count >= 256) {
      actions.push(
        foldCheckpointAction({
          sessionId: input.sessionId,
          parentId:
            SessionHandleStore.latestAction(input.sessionId, input.expectedRevision)?.id ?? null,
          revision: input.expectedRevision,
          at: input.now,
          reason: "interval",
          state,
        }),
      );
    }
    return yield* SessionHandleStore.commit({ ...input, actions });
  });
}

function needsProjection(action: LedgerAction.Append): boolean {
  if (action.kind === "compaction") return true;
  if (action.kind !== "turn") return false;
  const value = action.intent.value;
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value.phase === "intent" || value.phase === "resume")
  );
}

function pinContext(
  action: LedgerAction.Append,
  state: FoldCheckpoint.State,
  sourceRevision: number,
): LedgerAction.Append {
  if (action.kind !== "turn") return action;
  const value = action.intent.value;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.phase !== "intent" && value.phase !== "resume")
  )
    return action;
  const projection = foldSessionHistory(action.sessionId, [], state);
  const context = {
    snapshotActionId: action.id,
    sourceRevision,
    foldVersion: 1,
    projectionHash: canonicalDigest({
      foldVersion: 1,
      projection: PlainValueSchema.parse(projection),
    }),
    messageIds: projection.map((message) => message.info.id),
    successorActionId: state.successorActionId,
    projection,
  };
  const pinned = { ...value, context };
  const intent =
    value.phase === "intent" ? SessionTurn.Intent.parse(pinned) : SessionTurn.Resume.parse(pinned);
  return { ...action, intent: { encodingVersion: 1, value: PlainValueSchema.parse(intent) } };
}
