import type { Communication, Dispatch } from "@openomni/protocol";
import { PendingAskStore, PendingInteractionStore } from "@openomni/session";

type PendingInteractionCandidate = Readonly<{
  kind: "pending_interaction";
  key: `pending_interaction:${string}`;
  record: PendingInteractionStore.Record;
}>;

type PendingAskCandidate = Readonly<{
  kind: "pending_ask";
  key: `pending_ask:${string}`;
  record: Communication.PendingAsk.Record;
}>;

export type WaitCorrelationCandidate = PendingInteractionCandidate | PendingAskCandidate;

export type WaitCorrelationEffect =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "mark_pending_asks_ambiguous";
      pendingAskIds: readonly string[];
    }>;

export type ResolveWaitCorrelationInput = Readonly<{
  correlation?: Dispatch.Correlation;
  externalMessageId?: string;
}>;

export type WaitCorrelationResolution =
  | Readonly<{
      kind: "none";
      candidates: readonly [];
      effect: Readonly<{ kind: "none" }>;
    }>
  | Readonly<{
      kind: "match";
      candidate: WaitCorrelationCandidate;
      effect: Readonly<{ kind: "none" }>;
    }>
  | Readonly<{
      kind: "ambiguous";
      candidates: readonly WaitCorrelationCandidate[];
      effect: WaitCorrelationEffect;
    }>;

type WaitCorrelationQueryLevel = Readonly<{
  pendingInteraction: readonly Dispatch.Correlation[];
  pendingAsk: readonly Communication.PendingAsk.CorrelationQuery[];
}>;

function correlationQueryLevels(input: ResolveWaitCorrelationInput): WaitCorrelationQueryLevel[] {
  const levels: WaitCorrelationQueryLevel[] = [];
  const correlation = input.correlation;
  const scoped =
    correlation === undefined
      ? undefined
      : { endpointId: correlation.endpointId, channelId: correlation.channelId };

  if (correlation?.replyToMessageId) {
    const query = {
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      replyToMessageId: correlation.replyToMessageId,
    };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }
  if (correlation?.threadId) {
    const query = {
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      threadId: correlation.threadId,
    };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }
  if (correlation?.tokenHash) {
    const query = {
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      tokenHash: correlation.tokenHash,
    };
    levels.push({ pendingInteraction: [query], pendingAsk: [query] });
  }

  const pendingInteractionFallback: Dispatch.Correlation[] = [];
  const pendingAskFallback: Communication.PendingAsk.CorrelationQuery[] = [];
  if (correlation?.externalConversationId) {
    const query = {
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      externalConversationId: correlation.externalConversationId,
    };
    pendingInteractionFallback.push(query);
    pendingAskFallback.push(query);
  } else if (scoped !== undefined) {
    pendingInteractionFallback.push(scoped);
    pendingAskFallback.push(scoped);
  }
  if (input.externalMessageId) {
    pendingAskFallback.push(
      scoped === undefined
        ? { externalMessageId: input.externalMessageId }
        : { ...scoped, externalMessageId: input.externalMessageId },
    );
  }
  if (pendingInteractionFallback.length > 0 || pendingAskFallback.length > 0) {
    levels.push({
      pendingInteraction: pendingInteractionFallback,
      pendingAsk: pendingAskFallback,
    });
  }

  return levels;
}

function resolveCandidates(
  candidates: readonly WaitCorrelationCandidate[],
): WaitCorrelationResolution {
  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (candidate === undefined) throw new TypeError("single wait candidate is missing");
    return { kind: "match", candidate, effect: { kind: "none" } };
  }

  const pendingAskIds = candidates
    .filter((candidate): candidate is PendingAskCandidate => candidate.kind === "pending_ask")
    .map((candidate) => candidate.record.id)
    .sort();
  return {
    kind: "ambiguous",
    candidates,
    effect:
      pendingAskIds.length === 0
        ? { kind: "none" }
        : { kind: "mark_pending_asks_ambiguous", pendingAskIds },
  };
}

export function resolveWaitCorrelation(
  input: ResolveWaitCorrelationInput,
): WaitCorrelationResolution {
  for (const level of correlationQueryLevels(input)) {
    const rawCandidates: WaitCorrelationCandidate[] = [];
    for (const query of level.pendingInteraction) {
      for (const record of PendingInteractionStore.findByCorrelation(query)) {
        rawCandidates.push({
          kind: "pending_interaction",
          key: `pending_interaction:${record.id}`,
          record,
        });
      }
    }
    for (const query of level.pendingAsk) {
      for (const record of PendingAskStore.findByCorrelation(query)) {
        rawCandidates.push({ kind: "pending_ask", key: `pending_ask:${record.id}`, record });
      }
    }

    const candidates = [
      ...new Map(rawCandidates.map((candidate) => [candidate.key, candidate])).values(),
    ].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    if (candidates.length > 0) return resolveCandidates(candidates);
  }

  return { kind: "none", candidates: [], effect: { kind: "none" } };
}

export function applyWaitCorrelationEffect(effect: WaitCorrelationEffect): void {
  if (effect.kind === "none") return;
  for (const id of new Set(effect.pendingAskIds)) PendingAskStore.markAmbiguous(id);
}
