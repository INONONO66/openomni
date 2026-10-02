import type * as SessionHandleStore from "./store/fence";
import { Effect } from "effect";
import type { SessionKernel } from "./cluster/kernel-registry";
import { canonicalDigest, FoldCheckpoint, PlainValueSchema, SessionGeneration, SessionTurn, Inbox, type LedgerAction, type LedgerSession, type PlainValue, } from "@openomni/protocol";
import { z } from "zod";
import { RunReasonCode } from "./core/policy/reason-codes";
import { GenerationUnavailable, SessionCommitError } from "./errors";
import { SessionPolicyRefusal, type SessionRunnerResult, type SessionTool, } from "./session-contract";

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

export function requireCommit(result: LedgerSession.CommitResult): LedgerSession.Row {
  if (!result.ok) throw new SessionCommitError({ result });
  return result.row;
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
      kind: "inbox.deliver",
      intent: { encodingVersion: 1, value: { inboxId: item.id } },
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
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentActionId,
    sessionId: input.sessionId,
    kind: "prompt",
    intent: input.origin,
    effect: { encodingVersion: 1, value: { inboxKind: input.kind, content: input.content } },
    irreversible: true,
    ts: input.at,
  };
}

/**
 * Chain fold over received-message actions (W5.2 F1): every `prompt` action
 * carrying an inbox payload, projected to the historical inbox row shape.
 * Entries whose `<id>` a later `inbox.deliver` intent references are consumed.
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
      if (action.kind === "prompt") {
        const effect = ReceivedEffect.safeParse(action.effect.value);
        if (effect.success) received.push({ action, kind: effect.data.inboxKind, content: effect.data.content });
      } else if (action.kind === "inbox.deliver") {
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
