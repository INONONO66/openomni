import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Approval } from "@openomni/protocol";
import { Bus } from "../helpers/observation";
import { ApprovalStore, Storage } from "../../src/index";

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

const T0 = 1_000;
const DEADLINE = 60_000;
const BOUND = { windowMs: 600_000, maxPending: 2 };

const promotion: Approval.Subject = { kind: "contact_promotion", actorId: "actor-1" };

function requestOne(id = "approval-1", at = T0): Approval.Record {
  return ApprovalStore.request({ id, subject: promotion, deadline: DEADLINE }, BOUND, "trace-req", at);
}

function captureStoreError(fn: () => unknown): InstanceType<typeof Approval.StoreError> {
  try {
    fn();
  } catch (error) {
    if (Approval.StoreError.isInstance(error)) return error;
    throw error;
  }
  throw new Error("expected ApprovalStoreError, but nothing was thrown");
}

function ownerFacts(approvalId: string) {
  const ledger = Storage.get().ledger;
  if (!ledger) throw new Error("ledger sub-adapter missing");
  return ["approval.requested", "approval.decided"]
    .flatMap((type) => ledger.factsByType(type))
    .filter((fact) => fact.streamId === `approval:${approvalId}`)
    .sort((a, b) => a.seq - b.seq);
}

describe("ApprovalStore", () => {
  test("request opens a pending record with its fact at seq 1", () => {
    const record = requestOne();
    expect(record).toMatchObject({ state: "pending", revision: 1, deadline: DEADLINE });
    expect(ownerFacts("approval-1").map(({ seq, type }) => [seq, type])).toEqual([
      [1, "approval.requested"],
    ]);
  });

  test("the pending-volume bound refuses a request storm, fail-closed (§8.13)", () => {
    requestOne("approval-1");
    requestOne("approval-2");
    const flooded = captureStoreError(() => requestOne("approval-3"));
    expect(flooded.data.code).toBe("request_flooded");
    expect(ApprovalStore.get("approval-3")).toBeUndefined();

    // A decided request frees its pending slot.
    ApprovalStore.decide("approval-1", "refused", "trace-decide", T0 + 1);
    expect(requestOne("approval-3", T0 + 2).state).toBe("pending");
  });

  test("duplicate request ids fail closed with a typed duplicate error", () => {
    requestOne();
    const error = captureStoreError(() => requestOne());
    expect(error.data.code).toBe("duplicate");
    expect(ownerFacts("approval-1")).toHaveLength(1);
  });

  test("decide records the Owner's answer once and stays idempotent", async () => {
    requestOne();
    const decided: string[] = [];
    Bus.observe((event) => {
      if (event.name === "approval.decided") decided.push(event.name);
    });

    const first = ApprovalStore.decide("approval-1", "approved", "trace-decide", T0 + 1);
    expect(first.kind).toBe("decided");
    expect(first.record).toMatchObject({ state: "approved", decidedBy: "owner", revision: 2 });

    const again = ApprovalStore.decide("approval-1", "refused", "trace-decide-2", T0 + 2);
    expect(again.kind).toBe("unchanged");
    expect(again.record.state).toBe("approved");

    expect(ownerFacts("approval-1").map(({ seq, type }) => [seq, type])).toEqual([
      [1, "approval.requested"],
      [2, "approval.decided"],
    ]);
    await flushBus();
    expect(decided).toHaveLength(1);
  });

  test("an answer past the deadline records the deadline's refusal", () => {
    requestOne();
    const late = ApprovalStore.decide("approval-1", "approved", "trace-late", DEADLINE + 1);
    expect(late.record).toMatchObject({ state: "refused", decidedBy: "deadline" });
  });

  test("decision reads an unanswered request past its deadline as refused", () => {
    requestOne();
    expect(ApprovalStore.decision("approval-1", DEADLINE - 1)).toBe("pending");
    expect(ApprovalStore.decision("approval-1", DEADLINE)).toBe("refused");
    expect(ApprovalStore.get("approval-1")?.state).toBe("pending");
  });

  test("list filters by state", () => {
    requestOne("approval-1");
    requestOne("approval-2");
    ApprovalStore.decide("approval-2", "approved", "trace", T0 + 1);
    expect(ApprovalStore.list(["pending"]).map((record) => record.id)).toEqual(["approval-1"]);
    expect(ApprovalStore.list()).toHaveLength(2);
  });

  test("transitions on a missing approval fail closed with not_found", () => {
    expect(captureStoreError(() => ApprovalStore.decide("nope", "approved", "t", T0)).data.code).toBe(
      "not_found",
    );
    expect(captureStoreError(() => ApprovalStore.decision("nope", T0)).data.code).toBe("not_found");
  });

  test("reads on a bare adapter fail closed (adapter_absent)", () => {
    Storage.reset();
    Storage.configure({
      transaction: <T>(fn: () => T): T => fn(),
    } as unknown as Storage.Adapter);
    expect(captureStoreError(() => ApprovalStore.get("approval-1")).data.code).toBe(
      "adapter_absent",
    );
  });

  test("an adapter without the ledger append surface fails closed on request", () => {
    const adapter = Storage.get();
    Storage.reset();
    Storage.configure({ ...adapter, ledger: undefined } as unknown as Storage.Adapter);
    expect(
      captureStoreError(() =>
        ApprovalStore.request({ id: "approval-1", subject: promotion, deadline: DEADLINE }, BOUND, "t", T0),
      ).data.code,
    ).toBe("adapter_absent");
  });

  test("SQLITE_BUSY at the transaction entry surfaces as typed unavailable", () => {
    const adapter = Storage.get();
    const original = adapter.transaction.bind(adapter);
    Object.defineProperty(adapter, "transaction", {
      configurable: true,
      value: () => {
        const busy = new Error("database is locked") as Error & { code: string; errno: number };
        busy.code = "SQLITE_BUSY";
        busy.errno = 5;
        throw busy;
      },
    });
    try {
      expect(captureStoreError(() => requestOne()).data.code).toBe("unavailable");
    } finally {
      Object.defineProperty(adapter, "transaction", { configurable: true, value: original });
    }
  });

  test("a non-busy transaction failure propagates untyped", () => {
    const adapter = Storage.get();
    const original = adapter.transaction.bind(adapter);
    Object.defineProperty(adapter, "transaction", {
      configurable: true,
      value: () => {
        throw new Error("disk gone");
      },
    });
    try {
      expect(() => requestOne()).toThrow("disk gone");
    } finally {
      Object.defineProperty(adapter, "transaction", { configurable: true, value: original });
    }
  });

  test("a stale decision fails closed with revision_conflict and writes nothing", () => {
    requestOne();
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    const original = ledger.append.bind(ledger);
    // A decider whose ledger view lags the projection: the append refuses at
    // the stale head and the store must surface the typed conflict.
    Object.defineProperty(ledger, "append", {
      configurable: true,
      value: () => ({ kind: "cas_conflict", currentHead: 1 }),
    });
    try {
      expect(
        captureStoreError(() => ApprovalStore.decide("approval-1", "approved", "t", T0 + 1)).data.code,
      ).toBe("revision_conflict");
    } finally {
      Object.defineProperty(ledger, "append", { configurable: true, value: original });
    }
    expect(ApprovalStore.get("approval-1")?.state).toBe("pending");
  });

  test("compareAndSet guards the id and the exactly-once revision advance", () => {
    requestOne();
    const record = ApprovalStore.get("approval-1");
    if (!record) throw new Error("expected record");
    const sub = Storage.get().approval;
    if (!sub) throw new Error("expected approval sub-adapter");
    expect(() =>
      sub.compareAndSet("approval-1", 1, { ...record, id: "approval-other", revision: 2 }),
    ).toThrow("Approval id mismatch");
    expect(() => sub.compareAndSet("approval-1", 1, { ...record, revision: 3 })).toThrow(
      "Approval revision must advance exactly once",
    );
    expect(sub.compareAndSet("approval-1", 99, { ...record, revision: 100 })).toBe(false);
  });
});
