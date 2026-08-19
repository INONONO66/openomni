import { Engagement, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { isSqliteBusyError } from "../storage/sqlite-busy";
import { Storage } from "../storage/storage";

// Durable engagement writes fail closed (the Wait precedent): a missing
// sub-adapter is a typed error, never warn-and-return. The brain is this
// surface's SOLE writer (gateway-design §4/§5) — the gateway sees only
// engagementId values carried on §2 contracts.
function requireAdapter(): ProtocolStorage.EngagementSubAdapter {
  const adapter = Storage.get().engagement;
  if (!adapter) {
    throw new Engagement.StoreError({
      message:
        "Storage adapter does not implement engagement — durable engagement writes fail closed",
      code: "adapter_absent",
    });
  }
  return adapter;
}

/**
 * #510 discipline — every engagement state change is a decision-class fact on
 * the owner stream `engagement:<engagementId>` and awaits its durable append
 * before the projection write (no record, no action). Head↔revision binding
 * is the Wait shape: fact seq N produced projected revision N, `expectedHead`
 * is the revision BEFORE the transition, and append + projection CAS commit
 * inside ONE sync immediate storage transaction. No adoption path exists —
 * the stream class is born with the table, so a pre-cutover row is impossible.
 */
function requireLedger(): ProtocolStorage.LedgerSubAdapter {
  const ledger = Storage.get().ledger;
  if (!ledger) {
    throw new Engagement.StoreError({
      message:
        "Storage adapter does not implement ledger append — durable engagement writes fail closed",
      code: "adapter_absent",
    });
  }
  return ledger;
}

function engagementStreamId(engagementId: string): string {
  return `engagement:${engagementId}`;
}

function revisionConflict(
  engagementId: string,
  expected: number,
): InstanceType<typeof Engagement.StoreError> {
  return new Engagement.StoreError({
    message: `Engagement revision conflict: ${engagementId} expected=${expected}`,
    code: "revision_conflict",
    engagementId,
  });
}

function runEngagementTransaction<T>(engagementId: string, write: () => T): T {
  try {
    return Storage.get().transaction(write);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw new Engagement.StoreError({
        message: `Engagement storage busy: ${engagementId} — ${
          error instanceof Error ? error.message : String(error)
        }`,
        code: "unavailable",
        engagementId,
      });
    }
    throw error;
  }
}

type CommittedOutcome = Exclude<Engagement.Outcome, { kind: "rejected" }>;

/**
 * Decision-class fact for one committed fold outcome. Identity and edge
 * shape only — the delegation TITLE, the transition REASON, and the terms
 * text stay OUT of the immutable hash chain (Owner-authored content is
 * erasable; the projection row and the lossy user_audit Bus events carry it).
 */
function factOf(
  outcome: CommittedOutcome,
  requested: Engagement.State | undefined,
): { type: string; data: Record<string, unknown> } {
  const revision = outcome.record.revision;
  switch (outcome.kind) {
    case "transitioned":
      return {
        type: "engagement.transitioned",
        data: { from: outcome.from, to: outcome.to, forced: false, revision },
      };
    case "forced_approval":
      return {
        type: "engagement.transitioned",
        data: {
          from: outcome.from,
          to: "awaiting_user_approval",
          forced: true,
          requested: requested ?? outcome.requested,
          revision,
        },
      };
    case "expired":
      return { type: "engagement.expired", data: { from: outcome.from, revision } };
  }
}

function eventBase(record: Engagement.Record, time: number, traceId: string) {
  return {
    id: record.id,
    traceId,
    ownerSessionId: record.ownerSessionId,
    time,
  };
}

// Bus stays observe-only for the engagement decision class: these publishes
// are lossy projections of the appended facts and fire only AFTER the
// append+projection transaction committed. Transitions are user_audit — the
// engagement machine is the delegation safety mechanism, so every state
// change is Owner-visible by construction (gateway-design §0/§5).
function publishChange(outcome: CommittedOutcome, reason: string, traceId: string): void {
  const base = eventBase(outcome.record, outcome.record.updatedAt, traceId);
  switch (outcome.kind) {
    case "transitioned":
      Bus.publish(Engagement.Events.Transitioned, {
        ...base,
        from: outcome.from,
        to: outcome.record.state,
        reason,
        forced: false,
      });
      return;
    case "forced_approval":
      Bus.publish(Engagement.Events.Transitioned, {
        ...base,
        from: outcome.from,
        to: outcome.record.state,
        reason,
        forced: true,
      });
      return;
    case "expired":
      Bus.publish(Engagement.Events.Transitioned, {
        ...base,
        from: outcome.from,
        to: outcome.record.state,
        reason,
        forced: false,
      });
      return;
  }
}

const ACTIVE_STATES: Engagement.State[] = [
  "planning",
  "awaiting_external",
  "deliberating",
  "awaiting_user_approval",
  "acting",
];

export namespace EngagementStore {
  export type Record = Engagement.Record;

  /** Non-terminal states — the hydration slice and ownership lookups filter on these. */
  export const activeStates: readonly Engagement.State[] = ACTIVE_STATES;

  export function open(
    input: Engagement.Create,
    traceId: string,
    at = Date.now(),
  ): Engagement.Record {
    const adapter = requireAdapter();
    const ledger = requireLedger();
    // Single write-shape owner: Engagement.open is the factory (planning,
    // revision 1, expiresAt seeded from terms.deadline).
    const record = Engagement.open(Engagement.Create.parse(input), at);
    const duplicate = () =>
      new Engagement.StoreError({
        message: `Engagement already exists for id ${record.id}`,
        code: "duplicate",
        engagementId: record.id,
      });
    runEngagementTransaction(record.id, () => {
      const appended = ledger.append(
        {
          streamId: engagementStreamId(record.id),
          type: "engagement.opened",
          data: {
            ownerSessionId: record.ownerSessionId,
            expiresAt: record.expiresAt,
            revision: record.revision,
          },
        },
        0,
      );
      if (appended.kind === "cas_conflict") throw duplicate();
      if (!adapter.create(record)) throw duplicate();
    });
    Bus.publish(Engagement.Events.Opened, {
      ...eventBase(record, record.createdAt, traceId),
      title: record.title,
      state: record.state,
    });
    return record;
  }

  export function get(id: string): Engagement.Record | undefined {
    return requireAdapter().get(id);
  }

  export function list(filter?: ProtocolStorage.EngagementListFilter): Engagement.Record[] {
    return requireAdapter().list(filter);
  }

  /**
   * Persists one fold outcome: the decision-class fact appends to the
   * `engagement:<id>` stream FIRST, then the projection lands under a
   * revision compare-and-set — both inside one sync immediate storage
   * transaction (no record, no action). Rejected outcomes write nothing and
   * publish an internal rejection event; a stale head surfaces as the typed
   * revision_conflict.
   */
  export function transition(
    id: string,
    input: Engagement.TransitionInput,
    traceId: string,
  ): Engagement.Outcome {
    const parsed = Engagement.TransitionInput.parse(input);
    return applyFold(id, (record) => Engagement.transition(record, parsed), traceId, {
      reason: parsed.reason,
      requested: parsed.to,
    });
  }

  /** Deadline expiry — the machine's own edge (gateway-design §5 timeout behavior). */
  export function expire(id: string, traceId: string, at = Date.now()): Engagement.Outcome {
    return applyFold(id, (record) => Engagement.expire(record, { at }), traceId, {
      reason: "deadline expired",
    });
  }

  /**
   * The hydration read (gateway-design §5): active engagements for one
   * session, with lazy deadline expiry folded in first — an engagement whose
   * deadline passed leaves the active set (and lands its expiry fact) the
   * next time the session hydrates, without a sweeper daemon.
   */
  export function listActive(
    ownerSessionId: string,
    traceId: string,
    now = Date.now(),
  ): Engagement.Record[] {
    const active = requireAdapter().list({ ownerSessionId, states: [...ACTIVE_STATES] });
    const alive: Engagement.Record[] = [];
    for (const record of active) {
      if (record.expiresAt !== undefined && now > record.expiresAt) {
        try {
          expire(record.id, traceId, now);
        } catch (error) {
          // A concurrent hydration of the same session may have expired this
          // record first — the loser's CAS conflict is benign; either way the
          // record is terminal and stays filtered out of the alive set.
          if (!Engagement.StoreError.isInstance(error) || error.data.code !== "revision_conflict") {
            throw error;
          }
        }
        continue;
      }
      alive.push(record);
    }
    return alive;
  }

  function applyFold(
    id: string,
    step: (record: Engagement.Record) => Engagement.Outcome,
    traceId: string,
    meta: { reason: string; requested?: Engagement.State },
  ): Engagement.Outcome {
    const adapter = requireAdapter();
    const ledger = requireLedger();
    const current = adapter.get(id);
    if (!current) {
      throw new Engagement.StoreError({
        message: `Engagement not found: ${id}`,
        code: "not_found",
        engagementId: id,
      });
    }
    const outcome = step(current);
    if (outcome.kind === "rejected") {
      Bus.publish(Engagement.Events.TransitionRejected, {
        ...eventBase(outcome.record, outcome.at, traceId),
        code: outcome.code,
        requested: meta.requested ?? "expired",
        state: outcome.record.state,
      });
      return outcome;
    }
    const fact = factOf(outcome, meta.requested);
    runEngagementTransaction(id, () => {
      const appended = ledger.append(
        { streamId: engagementStreamId(id), type: fact.type, data: fact.data },
        current.revision,
      );
      if (appended.kind === "cas_conflict") throw revisionConflict(id, current.revision);
      if (!adapter.compareAndSet(id, current.revision, outcome.record)) {
        // Unreachable while every writer goes through this transaction (the
        // append CAS and the projection CAS guard the same head==revision);
        // kept as the explosive backstop — the rollback discards the appended
        // fact so head and revision still agree.
        throw revisionConflict(id, current.revision);
      }
    });
    publishChange(outcome, meta.reason, traceId);
    return outcome;
  }
}
