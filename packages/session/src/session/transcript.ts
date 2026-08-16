import { Transcript, type Message } from "@openomni/protocol";
import { Storage } from "../storage/storage";

/**
 * #547 C3 — the transcript record family: conversation history persists as
 * append-only Transcript.Fact rows (attempt-attributed), and the message/
 * part tables become fold projections of that stream (read-model
 * maintenance, never the record).
 *
 * Durability placement (the C3 design judgment): transcript facts are
 * RECORDING tier per the kernel contract — they record what the stream did,
 * they never authorize an action, so "no record, no action" does not bind
 * them. They therefore do NOT ride Ledger.append: putting per-part-boundary
 * streaming facts on the decision ledger would serialize the streaming path
 * onto per-session CAS heads and grow the boot-verified hash chain
 * (verifyTail) with streaming-volume rows — diluting the decision-class
 * semantics pinned by script/conformance/p2-ledger-baseline.test.ts.
 * Instead they land in the dedicated append-only `transcript_fact` table
 * (migration 0015) INSIDE the same Storage.transaction (BEGIN IMMEDIATE on
 * the synchronous=FULL primary connection) as the projection write — fact
 * and projection commit or roll back as one fsync unit, without competing
 * on decision streams.
 *
 * Recording discipline:
 *   - projectFrom escalates every fold `rejected` outcome to a loud
 *     TranscriptRecordingError: bad fact order is a recording defect, never
 *     a recoverable branch;
 *   - no mutation after recording: stored fact rows are append-only (the
 *     sub-adapter exposes no update surface); later lifecycle steps are NEW
 *     part.advanced facts;
 *   - attempt boundary = state boundary: each attempt folds from scratch
 *     under its attemptId (mirroring the llm processor), and a message's
 *     projection is its LATEST attempt's fold state.
 *
 * Writer census (which assistant writers record facts):
 *   - worker turns: facts (worker-runner onFact sink);
 *   - injected responses: facts (injection-queue persistResponse
 *     synthesizes message.created/part.appended/message.finished — #562);
 *   - resident direct runs: projection-only via
 *     SessionBridge.storeDirectResult (see defaultRunAgent in
 *     packages/openomni/src/resident/runtime.ts) — resident sessions have
 *     empty fact streams by design;
 *   - ingress writeback of worker output: projection-only, duplicating the
 *     worker's final fact-recorded turn;
 *   - child-agent streams: record nothing (bounded — child output reaches
 *     the parent as tool results carried by the parent's fact-recorded
 *     turns).
 * replay() is the fold's read-back — it reconstructs Message.WithParts from
 * the recorded stream and pins the live record() path (worker-runner
 * transcript and transcript-store tests fold what production wrote).
 *
 * This path deliberately publishes no Session.Event.Updated: it is a
 * recording-tier write; Event.Updated is the ingress-tier notification
 * (Session.addMessage/addPart). A subscriber that wants worker-produced
 * turns must gate on message.finished facts, not on Event.Updated.
 */
export class TranscriptRecordingError extends Error {
  readonly name = "TranscriptRecordingError";

  constructor(
    readonly reason: Transcript.RejectReason,
    readonly factType: Transcript.Fact["type"],
  ) {
    super(`transcript recording defect: ${reason} on ${factType}`);
  }
}

// Durable transcript writes fail closed: a missing sub-adapter is an error,
// never warn-and-continue — a session must not stream without its record.
function requireFacts(adapter: Storage.Adapter): NonNullable<Storage.Adapter["transcriptFact"]> {
  const facts = adapter.transcriptFact;
  if (!facts) {
    throw new Error(
      "Storage adapter does not implement transcript facts — transcript recording fails closed",
    );
  }
  return facts;
}

function messageIdOf(fact: Transcript.Fact): string {
  return fact.type === "message.created" ? fact.message.id : fact.messageId;
}

function parseRow(row: Storage.TranscriptFactRow): Transcript.Fact {
  // Service-entry enforcement on the read path too: a stored row that no
  // longer parses is corruption, surfaced loudly instead of skipped.
  return Transcript.Fact.parse(JSON.parse(row.data));
}

/**
 * Fold-projection maintenance: the message/part rows are read models of the
 * fact stream. message.created supersedes the previous attempt's projection
 * (the fact stream keeps the full history; the read model shows the latest
 * attempt only), part facts upsert exactly the part the fold advanced.
 */
function maintainProjection(
  adapter: Storage.Adapter,
  sessionID: string,
  fact: Transcript.Fact,
  state: Message.WithParts,
): void {
  adapter.message.set(sessionID, state.info);
  switch (fact.type) {
    case "message.created": {
      for (const part of adapter.part.list(state.info.id)) {
        adapter.part.remove(state.info.id, part.id);
      }
      return;
    }
    case "part.appended": {
      adapter.part.set(fact.messageId, fact.part);
      return;
    }
    case "part.advanced": {
      const part = state.parts.find((candidate) => candidate.id === fact.partId);
      // The fold applied this fact, so the advanced part exists by construction.
      if (part !== undefined) adapter.part.set(fact.messageId, part);
      return;
    }
    case "message.finished":
      return;
  }
}

/**
 * #562 F7: attemptId-keyed in-memory fold-state cache for the record path.
 * Without it every record refolds the attempt's whole persisted stream
 * inside BEGIN IMMEDIATE — O(n²) JSON.parse + fold per attempt. With it,
 * one fact folds onto the cached state in O(1); the stored-fact COUNT
 * (index-only) is the continuity check.
 *
 * Correctness envelope:
 *   - the cache is written ONLY after the storage transaction committed, so
 *     it always equals the fold of the attempt's durable facts;
 *   - continuity check: cached.factCount must equal the stored count read
 *     inside the same transaction — any divergence (process restart with a
 *     different DB, an outer transaction that rolled a committed savepoint
 *     back, a concurrent writer) falls back to the full refold. Restart
 *     safety is preserved on top of that: the llm processor issues fresh
 *     attemptIds after a restart, so a rebooted process never even hits a
 *     stale key;
 *   - message.finished evicts (the attempt is terminal — the fold rejects
 *     any later fact), and the cache is FIFO-bounded as a leak backstop for
 *     attempts that never finish.
 */
type FoldCacheEntry = { state: Message.WithParts; factCount: number };
const foldStateCache = new Map<string, FoldCacheEntry>();
const FOLD_CACHE_LIMIT = 256;

function foldCacheKey(sessionID: string, attemptId: string): string {
  return `${sessionID}\u0000${attemptId}`;
}

export namespace TranscriptStore {
  /**
   * Pure fold driver over an ordered fact stream. State is keyed by
   * attemptId (attempt boundary = state boundary); the projection of a
   * message is its latest attempt's state, in first-created message order.
   * A fold rejection escalates to a loud throw — recording defect.
   */
  export function projectFrom(facts: Iterable<Transcript.Fact>): Message.WithParts[] {
    const byAttempt = new Map<string, Message.WithParts>();
    const latestAttempt = new Map<string, string>();
    const messageOrder: string[] = [];

    for (const fact of facts) {
      if (fact.type === "message.created") {
        if (!latestAttempt.has(fact.message.id)) messageOrder.push(fact.message.id);
        latestAttempt.set(fact.message.id, fact.attemptId);
      }
      const outcome = Transcript.fold(byAttempt.get(fact.attemptId), fact);
      if ("rejected" in outcome) {
        throw new TranscriptRecordingError(outcome.reason, fact.type);
      }
      byAttempt.set(fact.attemptId, outcome.state);
    }

    return messageOrder.map((messageId) => {
      const state = byAttempt.get(latestAttempt.get(messageId) ?? "");
      if (state === undefined) {
        throw new TranscriptRecordingError("unknown_message", "message.created");
      }
      return state;
    });
  }

  /**
   * Records one fact: fold-validates it against the attempt's persisted
   * stream, appends the immutable fact row, and maintains the message/part
   * projection — all inside ONE storage transaction, so the projection can
   * never advance without its recorded fact (and vice versa). Returns the
   * attempt's fold state after the fact applied.
   */
  export function record(sessionID: string, fact: Transcript.Fact): Message.WithParts {
    const parsed = Transcript.Fact.parse(fact);
    if (parsed.type === "message.created" && parsed.message.sessionID !== sessionID) {
      throw new Error(
        `transcript fact sessionID mismatch: message carries ${parsed.message.sessionID}, recorded under ${sessionID}`,
      );
    }
    const adapter = Storage.get();
    const facts = requireFacts(adapter);
    const cacheKey = foldCacheKey(sessionID, parsed.attemptId);
    const committed = adapter.transaction(() => {
      // #562 F7: O(1) hot path — fold the one new fact onto the cached
      // attempt state when the stored-fact count confirms continuity;
      // anything else refolds the attempt's persisted stream (cold start,
      // restart, rolled-back outer transaction, foreign writer).
      const storedCount = facts.countByAttempt(sessionID, parsed.attemptId);
      const cached = foldStateCache.get(cacheKey);
      let state: Message.WithParts;
      if (cached !== undefined && cached.factCount === storedCount) {
        const outcome = Transcript.fold(cached.state, parsed);
        if ("rejected" in outcome) {
          throw new TranscriptRecordingError(outcome.reason, parsed.type);
        }
        state = outcome.state;
      } else {
        const stream = facts.listByAttempt(sessionID, parsed.attemptId).map(parseRow);
        const projected = projectFrom([...stream, parsed]);
        const refolded = projected.at(-1);
        if (refolded === undefined) {
          // Unreachable: projectFrom either threw or produced this attempt's
          // message state — kept as the explosive backstop.
          throw new TranscriptRecordingError("unknown_message", parsed.type);
        }
        state = refolded;
      }
      facts.append({
        sessionID,
        messageID: messageIdOf(parsed),
        attemptID: parsed.attemptId,
        type: parsed.type,
        data: JSON.stringify(parsed),
        timeCreated: Date.now(),
      });
      maintainProjection(adapter, sessionID, parsed, state);
      return { state, factCount: storedCount + 1 };
    });
    // Cache write only AFTER the transaction returned (committed, or — under
    // an outer transaction — reached a savepoint whose later rollback the
    // count continuity check catches on the next record).
    foldStateCache.delete(cacheKey);
    if (parsed.type !== "message.finished") {
      foldStateCache.set(cacheKey, committed);
      if (foldStateCache.size > FOLD_CACHE_LIMIT) {
        const oldest = foldStateCache.keys().next().value;
        if (oldest !== undefined) foldStateCache.delete(oldest);
      }
    }
    return committed.state;
  }

  /**
   * Resume-by-replay: parses the session's persisted fact stream and refolds
   * it through projectFrom. Deterministic — byte-identical to the projection
   * the record path maintained, because both fold the same parsed facts.
   */
  export function replay(sessionID: string): Message.WithParts[] {
    const facts = requireFacts(Storage.get());
    return projectFrom(facts.list(sessionID).map(parseRow));
  }
}
