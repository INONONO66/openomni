import type { CommitReceipt } from "./store/services";
import type { LedgerError } from "./store/errors";
import { Effect } from "effect";
import type { SessionKernel } from "./entity";
import { canonicalDigest, JournalKind, PlainValueSchema, SessionTurn, FoldCheckpoint, type LedgerAction, type LedgerSession, SessionGeneration, Inbox, type PlainValue } from "@openomni/protocol";
import { foldHistoryState, foldSessionHistory, readHistoryCheckpoint } from "../inspect/history";
import { pinCompactionAction } from "../plugins/compaction/successor";
import type * as SessionHandleStore from "./store/fence";
import { z } from "zod";
import { RunReasonCode } from "./reason-codes";
import { GenerationUnavailable } from "./failure";
import { SessionPolicyRefusal } from "./messages";
import type { SessionRunnerResult, SessionTool } from "./run";

// ─── from session-fold-commit.ts (#1247) ───
/** Synchronous decoration preserves durable admission's existing suspension schedule. */
export function commitFoldBatch(
  kernel: SessionKernel,
  input: LedgerSession.Commit,
): Effect.Effect<CommitReceipt, LedgerError> {
  return Effect.gen(function* () {
    const checkpoint = readHistoryCheckpoint(kernel, input.sessionId, input.expectedRevision);
    const incoming = input.actions.filter((action) => action.kind !== "fold.checkpoint").length;
    if (checkpoint.nonCheckpointActions + incoming < 256 && !input.actions.some(needsProjection))
      return yield* kernel.commit(input);
    const hydrated = checkpoint.hydrate();
    let state = hydrated.state;
    let count = hydrated.nonCheckpointActions;
    const actions: LedgerAction.Append[] = [];
    for (const draft of input.actions) {
      const sourceRevision = input.expectedRevision + actions.length;
      const action = pinCompactionAction(
        kernel,
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
            kernel.latestAction(input.sessionId, input.expectedRevision)?.id ?? null,
          revision: input.expectedRevision,
          at: input.now,
          reason: "interval",
          state,
        }),
      );
    }
    return yield* kernel.commit({ ...input, actions });
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

// ─── from session-record.ts (#1247) ───
export function foldCheckpointAction(input: {
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly revision: number;
  readonly at: number;
  readonly reason: "interval" | "compaction";
  readonly state: FoldCheckpoint.State;
}): LedgerAction.Append {
  const state = PlainValueSchema.parse(input.state);
  return {
    id: `${input.sessionId}:fold:${input.revision}`,
    sessionId: input.sessionId,
    parentId: input.parentId,
    kind: "fold.checkpoint",
    intent: {
      encodingVersion: 1,
      value: PlainValueSchema.parse(
        FoldCheckpoint.Intent.parse({
          phase: "checkpoint",
          foldVersion: 1,
          revision: input.revision,
          reason: input.reason,
        }),
      ),
    },
    effect: {
      encodingVersion: 1,
      value: PlainValueSchema.parse(
        FoldCheckpoint.Effect.parse({
          phase: "result",
          terminal: "executed",
          result: {
            foldVersion: 1,
            revision: input.revision,
            state,
            stateHash: canonicalDigest({ foldVersion: 1, state }),
          },
        }),
      ),
    },
    irreversible: true,
    ts: input.at,
  };
}

export function toolSnapshot(tool: SessionTool): SessionGeneration.Tool {
  return SessionGeneration.Tool.parse(tool);
}

export function internalOrigin(sessionId: string): Inbox.Origin {
  return { encodingVersion: 1, value: { kind: "session", id: sessionId } };
}


interface TurnEnvelopeActionInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly generation: SessionGeneration.Snapshot;
  readonly at: number;
}

interface TurnPinnedInput {
  readonly generation: SessionGeneration.Snapshot;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
}

function pinnedTurn(
  input: TurnPinnedInput,
): Omit<SessionTurn.Intent, "phase" | "inboxIds" | "context"> {
  return {
    resultId: input.resultId,
    toolsGeneration: input.generation.generation,
    toolsHash: input.generation.toolsHash,
    systemHash: input.generation.systemHash,
    policyGeneration: input.generation.policyGeneration,
    resumeCount: input.resumeCount,
    boundaryActionId: input.boundaryActionId,
  };
}

function turnEnvelopeAction(
  input: TurnEnvelopeActionInput,
  intent: SessionTurn.DecodeIntent | SessionTurn.DecodeResume,
): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: PlainValueSchema.parse(intent) },
    effect: { encodingVersion: 1, value: SessionTurn.Pending.parse({ phase: "pending" }) },
    irreversible: true,
    ts: input.at,
  };
}

export function turnIntentAction(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly resultId: string;
  readonly inboxIds: readonly string[];
  readonly generation: SessionGeneration.Snapshot;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return turnEnvelopeAction(
    input,
    SessionTurn.DecodeIntent.parse({
      phase: "intent",
      inboxIds: [...input.inboxIds],
      ...pinnedTurn(input),
    }),
  );
}

export function turnResumeAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resultId: string;
  readonly generation: SessionGeneration.Snapshot;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return turnEnvelopeAction(
    input,
    SessionTurn.DecodeResume.parse({
      phase: "resume",
      turnId: input.turnId,
      ...pinnedTurn(input),
    }),
  );
}

export function turnCheckpointAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly boundaryActionId: string;
  readonly boundary: SessionTurn.Boundary;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "checkpoint", turnId: input.turnId } },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "checkpoint",
        turnId: input.turnId,
        resultId: input.resultId,
        resumeCount: input.resumeCount,
        boundaryActionId: input.boundaryActionId,
        boundary: input.boundary,
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

/**
 * The journal row kind one delivered input lands as (#1252): `prompt` and
 * `action` inputs are rows of their own kind; interrupt/resume control is a
 * `signal` row. The single mapping both the admission constructor and the
 * delivery constructor share.
 */
export function inputRowKind(kind: Inbox.Kind): "prompt" | "signal" | "action" {
  return kind === "prompt" || kind === "action" ? kind : "signal";
}

export function deliveryActions(
  items: readonly Inbox.Row[],
  target:
    | { readonly kind: "turn"; readonly turnId: string }
    | { readonly kind: "inbox" },
  boundary: SessionTurn.Boundary,
  parentId: string | null,
): LedgerAction.Append[] {
  let parent = parentId;
  return items.map((item) => {
    const action: LedgerAction.Append = {
      id: `${item.id}:delivery`,
      parentId: parent,
      sessionId: item.sessionId,
      // #1252: a delivered input is a journal row of its own kind — `prompt`
      // for turn inputs, `signal` for interrupt/resume control. The retired
      // `inbox.deliver` kind had one writer here; this constructor keeps it.
      kind: inputRowKind(item.kind),
      intent: {
        encodingVersion: 1,
        value:
          item.kind === "interrupt" || item.kind === "resume"
            ? { inboxId: item.id, control: item.kind }
            : { inboxId: item.id, delivery: JournalKind.DEFAULT_DELIVERY },
      },
      effect: {
        encodingVersion: 1,
        value: {
          phase: "delivery",
          turnId: target.kind === "turn" ? target.turnId : item.id,
          inboxId: item.id,
          kind: item.kind,
          content: item.content,
          origin: item.origin,
          boundary,
        },
      },
      irreversible: true,
      ts: item.createdAt,
    };
    parent = action.id;
    return action;
  });
}

export function turnTerminalAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly result: SessionRunnerResult;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal", turnId: input.turnId } },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "terminal",
        turnId: input.turnId,
        kind: input.result.kind,
        ...(input.result.kind === "waiting"
          ? { reason: input.result.reason, alarmIds: [...input.result.alarmIds] }
          : {}),
        text: input.result.text ?? "",
        boundaryActionId: input.boundaryActionId,
        resumeCount: input.resumeCount,
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

/** The gate's turn-stop row (#1252): constructed here, the turn kind's single writer. */
export function turnStopAction(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly generation: number;
  readonly verdict: PlainValue;
  readonly state: PlainValue;
  readonly ts: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: { phase: "stop", generation: input.generation },
    },
    effect: {
      encodingVersion: 1,
      value: { phase: "stop", verdict: input.verdict, state: input.state },
    },
    irreversible: true,
    ts: input.ts,
  };
}

export function policyRefusalResult(reason: string): SessionRunnerResult {
  const cause = new SessionPolicyRefusal(reason);
  return { kind: "error", text: cause.message, cause };
}

export function sessionRunnerResultValue(result: SessionRunnerResult): PlainValue {
  if (result.kind === "waiting") return { ...result, alarmIds: [...result.alarmIds] };
  if (result.kind === "interrupted") {
    return { kind: result.kind, ...(result.text === undefined ? {} : { text: result.text }) };
  }
  if (result.kind === "error") {
    return {
      kind: result.kind,
      text: result.text,
      ...(result.reported === undefined ? {} : { reported: result.reported }),
    };
  }
  return {
    kind: result.kind,
    text: result.text,
    ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
    ...(result.usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            ...(result.usage.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: result.usage.reasoningTokens }),
            ...(result.usage.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: result.usage.cacheReadTokens }),
            ...(result.usage.cacheWriteTokens === undefined
              ? {}
              : { cacheWriteTokens: result.usage.cacheWriteTokens }),
          },
        }),
  };
}

const SessionUsage = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  reasoningTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
});

const SessionResult = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("result"),
    text: z.string(),
    finishReason: z.enum(["stop", "max-steps", RunReasonCode.Stalled]).optional(),
    usage: SessionUsage.optional(),
  }),
  z.strictObject({
    kind: z.literal("waiting"),
    text: z.string(),
    reason: z.literal("live_wait"),
    alarmIds: z.array(z.string()).nonempty(),
  }),
  z.strictObject({ kind: z.literal("interrupted"), text: z.string().optional() }),
  z.strictObject({
    kind: z.literal("error"),
    text: z.string(),
    reported: z.literal(true).optional(),
  }),
]);

export function sessionRunnerResultFromValue(value: PlainValue): SessionRunnerResult | undefined {
  const result = SessionResult.safeParse(value);
  return result.success ? result.data : undefined;
}

export function generationForOpen(
  kernel: SessionKernel,
  open: SessionHandleStore.OpenTurn,
): Effect.Effect<SessionGeneration.Snapshot, GenerationUnavailable> {
  const snapshot = kernel.generationFor(open.action.sessionId, open.toolsGeneration);
  if (
    snapshot === undefined ||
    snapshot.toolsHash !== open.toolsHash ||
    snapshot.systemHash !== open.systemHash ||
    snapshot.policyGeneration !== open.policyGeneration
  ) {
    return Effect.fail(new GenerationUnavailable({ generation: open.toolsGeneration }));
  }
  return Effect.succeed(snapshot);
}

/** The chain effect one received message commits; the pending fold reads it back. */
const ReceivedEffect = z.object({ inboxKind: Inbox.Kind, content: z.string() });
const DeliverIntent = z.object({ inboxId: z.string() });

/** The durable chain action for one received message (the inbox table is gone; the chain is the inbox). */
export function receivedMessageAction(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: Inbox.Kind;
  readonly content: string;
  readonly origin: Inbox.Origin;
  readonly parentActionId: string | null;
  readonly at: number;
  /** Loop-consumption delivery the input row carries (#1253); absent folds to the `followUp` default. */
  readonly delivery?: JournalKind.Delivery;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentActionId,
    sessionId: input.sessionId,
    // #1252: control inputs (interrupt/resume) are signal rows; prompts are prompt rows.
    kind: inputRowKind(input.kind),
    intent: input.origin,
    effect: {
      encodingVersion: 1,
      value: {
        inboxKind: input.kind,
        content: input.content,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

/**
 * Chain fold over received-message actions (W5.2 F1): every `prompt` action
 * carrying an inbox payload, projected to the historical inbox row shape.
 * Entries whose `<id>` a later delivery row's intent references are consumed.
 */
export function receivedMessages(
  kernel: SessionKernel,
  sessionId: string,
): { readonly rows: Inbox.Row[]; readonly delivered: ReadonlySet<string> } {
  const received: { readonly action: LedgerAction.Node; readonly kind: Inbox.Kind; readonly content: string }[] = [];
  const delivered = new Set<string>();
  let afterRevision = 0;
  for (;;) {
    const page = kernel.historyPage(sessionId, { afterRevision, limit: 256 });
    for (const action of page.actions) {
      if (action.kind === "prompt" || action.kind === "signal" || action.kind === "action") {
        const effect = ReceivedEffect.safeParse(action.effect.value);
        if (effect.success) received.push({ action, kind: effect.data.inboxKind, content: effect.data.content });
        const intent = DeliverIntent.safeParse(action.intent.value);
        if (intent.success) delivered.add(intent.data.inboxId);
      }
    }
    if (page.nextRevision === null) break;
    afterRevision = page.nextRevision;
  }
  return {
    delivered,
    rows: received.map((entry, index) =>
      Inbox.Row.parse({
        id: entry.action.id,
        sessionId,
        kind: entry.kind,
        content: entry.content,
        origin: entry.action.intent,
        status: delivered.has(entry.action.id) ? "consumed" : "pending",
        consumedBy: null,
        consumedAt: null,
        createdAt: entry.action.ts,
        ordinal: index + 1,
      }),
    ),
  };
}

/** Pending admission over a per-session file is the kernel's chain fold (plan F1). */
export function pendingBacklog(kernel: SessionKernel, sessionId: string): Inbox.Row[] {
  return kernel.pendingMessages(sessionId);
}
