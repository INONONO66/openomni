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

function pendingInteractionQueries(
  correlation: Dispatch.Correlation | undefined,
): Dispatch.Correlation[] {
  if (correlation === undefined) return [];
  const base = { endpointId: correlation.endpointId, channelId: correlation.channelId };
  const queries: Dispatch.Correlation[] = [];
  if (correlation.replyToMessageId) {
    queries.push({ ...base, replyToMessageId: correlation.replyToMessageId });
  }
  if (correlation.threadId) queries.push({ ...base, threadId: correlation.threadId });
  if (correlation.tokenHash) queries.push({ ...base, tokenHash: correlation.tokenHash });
  if (correlation.externalConversationId) {
    queries.push({ ...base, externalConversationId: correlation.externalConversationId });
  }
  if (queries.length === 0) queries.push(base);
  return queries;
}

function pendingAskQueries(
  correlation: Dispatch.Correlation | undefined,
  externalMessageId: string | undefined,
): Communication.PendingAsk.CorrelationQuery[] {
  const queries: Communication.PendingAsk.CorrelationQuery[] = [];
  if (correlation !== undefined) {
    const scoped = { endpointId: correlation.endpointId, channelId: correlation.channelId };
    if (correlation.tokenHash) queries.push({ ...scoped, tokenHash: correlation.tokenHash });
    if (correlation.externalConversationId) {
      queries.push({ ...scoped, externalConversationId: correlation.externalConversationId });
    }
    if (correlation.replyToMessageId) {
      queries.push({ ...scoped, replyToMessageId: correlation.replyToMessageId });
    }
    if (correlation.threadId) queries.push({ ...scoped, threadId: correlation.threadId });
  }
  if (externalMessageId) {
    queries.push(
      correlation === undefined
        ? { externalMessageId }
        : {
            endpointId: correlation.endpointId,
            channelId: correlation.channelId,
            externalMessageId,
          },
    );
  }
  return queries;
}

export function resolveWaitCorrelation(
  input: ResolveWaitCorrelationInput,
): WaitCorrelationResolution {
  const rawCandidates: WaitCorrelationCandidate[] = [];

  for (const query of pendingInteractionQueries(input.correlation)) {
    for (const record of PendingInteractionStore.findByCorrelation(query)) {
      rawCandidates.push({
        kind: "pending_interaction",
        key: `pending_interaction:${record.id}`,
        record,
      });
    }
  }
  for (const query of pendingAskQueries(input.correlation, input.externalMessageId)) {
    for (const record of PendingAskStore.findByCorrelation(query)) {
      rawCandidates.push({ kind: "pending_ask", key: `pending_ask:${record.id}`, record });
    }
  }

  const candidates = [
    ...new Map(rawCandidates.map((candidate) => [candidate.key, candidate])).values(),
  ].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  if (candidates.length === 0) {
    return { kind: "none", candidates: [], effect: { kind: "none" } };
  }
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

export function applyWaitCorrelationEffect(effect: WaitCorrelationEffect): void {
  if (effect.kind === "none") return;
  for (const id of new Set(effect.pendingAskIds)) PendingAskStore.markAmbiguous(id);
}
