import { Approval, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { commitFact, runCommitTransaction } from "../storage/commit-coordinator";
import { Storage } from "../storage/storage";

// Durable Approval writes fail closed: a missing sub-adapter is a typed
// error, never warn-and-return — the same law the conversation and lease
// stores ship.
function requireAdapter(): ProtocolStorage.ApprovalSubAdapter {
  const adapter = Storage.get().approval;
  if (!adapter) {
    throw new Approval.StoreError({
      message: "Storage adapter does not implement approval — durable Approval writes fail closed",
      code: "adapter_absent",
    });
  }
  return adapter;
}

/**
 * Every Approval state change is a decision-class fact on the owner stream
 * `approval:<id>` and awaits its durable append before the projection write
 * (no record, no action). Head↔revision binding mirrors the conversation
 * and lease streams: fact seq N produced projected revision N,
 * `expectedHead` is the revision BEFORE the transition, and append +
 * projection CAS commit inside ONE sync immediate storage transaction. No
 * adoption path — the stream class is born post-cutover.
 */
function requireLedger(): ProtocolStorage.LedgerSubAdapter {
  const ledger = Storage.get().ledger;
  if (!ledger) {
    throw new Approval.StoreError({
      message:
        "Storage adapter does not implement ledger append — durable Approval writes fail closed",
      code: "adapter_absent",
    });
  }
  return ledger;
}

function streamId(approvalId: string): string {
  return `approval:${approvalId}`;
}

function revisionConflict(
  approvalId: string,
  expected: number,
): InstanceType<typeof Approval.StoreError> {
  return new Approval.StoreError({
    message: `Approval revision conflict: ${approvalId} expected=${expected}`,
    code: "revision_conflict",
    approvalId,
  });
}

/** SQLITE_BUSY means nothing committed — map it to Approval's typed taxonomy. */
function runApprovalTransaction<T>(approvalId: string, write: () => T): T {
  return runCommitTransaction(
    Storage.get(),
    write,
    (cause) =>
      new Approval.StoreError({
        message: `Approval storage busy: ${approvalId} — ${cause instanceof Error ? cause.message : String(cause)}`,
        code: "unavailable",
        approvalId,
      }),
  );
}

// Every approval event inherits its caller's trace — no mint in the store (D11).
function eventBase(record: Approval.Record, traceId: string, time: number) {
  return {
    traceId,
    approvalId: record.id,
    subject: record.subject,
    time,
  };
}

/** The §8.13 anti-fatigue bound the requester supplies: pending volume per rolling window. */
type RequestBound = Readonly<{ windowMs: number; maxPending: number }>;

export namespace ApprovalStore {
  export type Record = Approval.Record;

  /**
   * Opens a pending approval request (§6). The volume bound is enforced
   * HERE, atomically with the create — more than `maxPending` pending
   * requests inside the rolling window is a typed `request_flooded`
   * refusal, so an approval storm can never bury the Owner (§8.13). All
   * inside one transaction with the approval.requested fact append
   * (record-before-act).
   */
  export function request(
    create: Approval.Create,
    bound: RequestBound,
    traceId: string,
    at = Date.now(),
  ): Approval.Record {
    const adapter = requireAdapter();
    const ledger = requireLedger();
    const record = Approval.request(create, at);
    runApprovalTransaction(record.id, () => {
      const pending = adapter.countPendingSince(at - bound.windowMs);
      if (pending >= bound.maxPending) {
        throw new Approval.StoreError({
          message: `Approval request ${record.id} refused: ${pending} pending requests already opened in the last ${bound.windowMs}ms (max ${bound.maxPending})`,
          code: "request_flooded",
          approvalId: record.id,
        });
      }
      const duplicate = () =>
        new Approval.StoreError({
          message: `Approval already exists for id ${record.id}`,
          code: "duplicate",
          approvalId: record.id,
        });
      const committed = commitFact(
        ledger,
        {
          streamId: streamId(record.id),
          expectedHead: 0,
          fact: {
            type: "approval.requested",
            data: {
              subject: record.subject,
              deadline: record.deadline,
              revision: record.revision,
            },
          },
        },
        () => adapter.create(record) || false,
      );
      if (committed.kind !== "committed") throw duplicate();
    });
    Bus.publish(Approval.Events.Requested, {
      ...eventBase(record, traceId, record.createdAt),
      deadline: record.deadline,
    });
    return record;
  }

  export function get(id: string): Approval.Record | undefined {
    return requireAdapter().get(id);
  }

  export function list(state?: Approval.State[]): Approval.Record[] {
    return requireAdapter().list(state);
  }

  /**
   * Records the Owner's answer. Idempotent: deciding a settled request
   * returns `unchanged` with the first settlement; an answer at or past the
   * deadline records the deadline's refusal (the fold owns that clamp).
   */
  export function decide(
    id: string,
    answer: "approved" | "refused",
    traceId: string,
    at = Date.now(),
  ): Approval.DecideOutcome {
    const adapter = requireAdapter();
    const ledger = requireLedger();
    const current = adapter.get(id);
    if (!current) {
      throw new Approval.StoreError({
        message: `Approval not found: ${id}`,
        code: "not_found",
        approvalId: id,
      });
    }
    const outcome = Approval.decide(current, answer, at);
    if (outcome.kind === "unchanged") return outcome;
    runApprovalTransaction(id, () => {
      const committed = commitFact(
        ledger,
        {
          streamId: streamId(id),
          expectedHead: current.revision,
          fact: {
            type: "approval.decided",
            data: {
              state: outcome.record.state,
              decidedBy: outcome.record.decidedBy,
              revision: outcome.record.revision,
            },
          },
        },
        () => adapter.compareAndSet(id, current.revision, outcome.record) || false,
      );
      if (committed.kind !== "committed") throw revisionConflict(id, current.revision);
    });
    const decidedBy = outcome.record.decidedBy;
    const state = outcome.record.state;
    if (decidedBy !== undefined && state !== "pending") {
      Bus.publish(Approval.Events.Decided, {
        ...eventBase(outcome.record, traceId, outcome.record.updatedAt),
        state,
        decidedBy,
      });
    }
    return outcome;
  }

  /**
   * The consuming read (§8.13): what request `id` authorizes AT `at`. A
   * pending request past its deadline reads as refused without a recorded
   * settlement — unanswered IS refusal, exactly like lease expiry.
   */
  export function decision(id: string, at = Date.now()): Approval.State {
    const record = requireAdapter().get(id);
    if (!record) {
      throw new Approval.StoreError({
        message: `Approval not found: ${id}`,
        code: "not_found",
        approvalId: id,
      });
    }
    return Approval.decision(record, at);
  }
}
