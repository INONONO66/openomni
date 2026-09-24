import { SessionHandleStore } from "@openomni/ledger";
import {
  canonicalDigest,
  Message,
  NamedError,
  PlainObjectSchema,
  PlainValueSchema,
  type FoldCheckpoint,
  type LedgerAction,
  type PlainObject,
} from "@openomni/protocol";
import { z } from "zod";
import { foldSessionHistory, hydrateSessionHistory } from "../session-lifecycle/history";

export const CompactionPredecessorError = NamedError.create(
  "CompactionPredecessorError",
  z
    .object({
      code: z.literal("compaction_predecessor_changed"),
      sessionId: z.string(),
      actionId: z.string(),
    })
    .strict(),
);

const Source = z
  .object({
    sourceRevision: z.number().int().nonnegative(),
    foldVersion: z.literal(1),
    predecessorActionId: z.string().nullable(),
    predecessorProjectionHash: z.string(),
  })
  .strict();
type Source = z.infer<typeof Source>;

function refuse(action: LedgerAction.Append): never {
  throw new CompactionPredecessorError({
    code: "compaction_predecessor_changed",
    sessionId: action.sessionId,
    actionId: action.id,
  });
}

function identity(sessionId: string, state: FoldCheckpoint.State, sourceRevision: number): Source {
  const projection = foldSessionHistory(sessionId, [], state);
  return {
    sourceRevision,
    foldVersion: 1,
    predecessorActionId: state.successorActionId,
    predecessorProjectionHash: canonicalDigest({
      foldVersion: 1,
      projection: PlainValueSchema.parse(projection),
    }),
  };
}

function pinIntent(
  action: LedgerAction.Append,
  intent: PlainObject,
  current: Source,
): LedgerAction.Append {
  const prepared = PlainObjectSchema.safeParse(intent.value);
  if (
    prepared.success &&
    prepared.data.predecessorProjectionHash !== undefined &&
    prepared.data.predecessorProjectionHash !== current.predecessorProjectionHash
  )
    refuse(action);
  return { ...action, intent: { encodingVersion: 1, value: { ...intent, context: current } } };
}

function capturedSource(action: LedgerAction.Append): Source {
  const parent =
    action.parentId === null ? undefined : SessionHandleStore.actionById(action.parentId);
  if (parent?.sessionId !== action.sessionId) return refuse(action);
  const intent = PlainObjectSchema.parse(parent.intent.value);
  if (intent.context === undefined) {
    const prior = hydrateSessionHistory(action.sessionId, parent.ordinal - 1);
    return identity(action.sessionId, prior.state, prior.revision);
  }
  const captured = Source.safeParse(intent.context);
  return captured.success ? captured.data : refuse(action);
}

function pinResult(
  action: LedgerAction.Append,
  effect: PlainObject,
  value: PlainObject,
  current: Source,
): LedgerAction.Append {
  const captured = capturedSource(action);
  if (
    captured.predecessorProjectionHash !== current.predecessorProjectionHash ||
    captured.predecessorActionId !== current.predecessorActionId ||
    captured.sourceRevision > current.sourceRevision
  )
    refuse(action);
  const projection = z.array(Message.WithParts).parse(value.projection);
  const result = PlainValueSchema.parse({
    ...value,
    ...captured,
    successorActionId: effect.phase === "boundary" ? `${action.parentId}:result` : action.id,
    messageIds: projection.map((message) => message.info.id),
    projection,
    projectionHash: canonicalDigest({
      foldVersion: 1,
      projection: PlainValueSchema.parse(projection),
    }),
  });
  return {
    ...action,
    effect: {
      encodingVersion: 1,
      value: { ...effect, result, resultHash: canonicalDigest(result) },
    },
  };
}

/** The admission watermark and successor proof share the caller's fenced commit. */
export function pinCompactionAction(
  action: LedgerAction.Append,
  state: FoldCheckpoint.State,
  sourceRevision: number,
): LedgerAction.Append {
  if (action.kind !== "compaction") return action;
  const intent = PlainObjectSchema.parse(action.intent.value);
  const effect = PlainObjectSchema.parse(action.effect.value);
  const current = identity(action.sessionId, state, sourceRevision);
  if (intent.phase === "intent") return pinIntent(action, intent, current);
  if (effect.phase !== "boundary" && (effect.phase !== "result" || effect.terminal !== "executed"))
    return action;
  const value = PlainObjectSchema.safeParse(effect.result);
  if (!value.success || !Array.isArray(value.data.projection)) return action;
  return pinResult(action, effect, value.data, current);
}
