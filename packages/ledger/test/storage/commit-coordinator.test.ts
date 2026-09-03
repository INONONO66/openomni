import { describe, expect, test } from "bun:test";
import { Ledger, type Storage as ProtocolStorage } from "@openomni/protocol";
import { commitFact, runCommitTransaction } from "../../src/storage/commit-coordinator";

/**
 * Direct characterization of the commit coordinator's ORDERING rules, at the
 * seam where the stores meet it. The cross-store observable sequence is
 * pinned in commit-sequencing.test.ts; this file pins the decisions the
 * coordinator alone makes, which no single store's suite can distinguish:
 *
 *   - the projection step runs only AFTER a successful append;
 *   - a projection CAS loss refuses the commit (so the caller's transaction
 *     rolls the appended fact back);
 *   - adoption fires ONLY on the pre-cutover signature (empty stream under a
 *     projection at revision >= 1), never on a genuine lost race, and never
 *     when the domain declares no adoption path;
 *   - a losing adopter is the same refusal as any stale head;
 *   - SQLITE_BUSY maps to the CALLER's typed error, not the driver's.
 */

const STREAM = "wait:w-1";
const FACT = { type: "wait.resolved", data: { by: "u-1" } } as const;
const GENESIS: Ledger.AdoptGenesis = { type: "wait.adopted", data: { revision: 3 } };

type AppendCall = Readonly<{ expectedHead: number }>;

/**
 * Records every ledger interaction in order. `appendResults` is consumed one
 * call at a time so a test can script "conflict, then success" across the
 * adoption retry.
 */
function fakeLedger(
  appendResults: Ledger.Outcome[],
  adopt?: () => void,
): ProtocolStorage.LedgerSubAdapter & {
  appends: AppendCall[];
  adoptions: number[];
  order: string[];
} {
  const appends: AppendCall[] = [];
  const adoptions: number[] = [];
  const order: string[] = [];
  const remaining = [...appendResults];
  const ledger = {
    append(_event: unknown, expectedHead: number): Ledger.Outcome {
      appends.push({ expectedHead });
      order.push("append");
      const next = remaining.shift();
      if (!next) throw new Error("unscripted append");
      return next;
    },
    adoptStream(_streamId: string, headRevision: number): void {
      adoptions.push(headRevision);
      order.push("adopt");
      adopt?.();
    },
    appends,
    adoptions,
    order,
  };
  return ledger as unknown as ProtocolStorage.LedgerSubAdapter & {
    appends: AppendCall[];
    adoptions: number[];
    order: string[];
  };
}

const committed = (seq: number): Ledger.Outcome => ({ kind: "appended", seq }) as Ledger.Outcome;
const conflict = (currentHead: number): Ledger.Outcome =>
  ({ kind: "cas_conflict", currentHead }) as Ledger.Outcome;

describe("commitFact ordering", () => {
  test("appends at the expected head, then projects", () => {
    const ledger = fakeLedger([committed(4)]);
    const outcome = commitFact(ledger, { streamId: STREAM, expectedHead: 3, fact: FACT }, () => {
      ledger.order.push("project");
      return "row" as const;
    });

    expect(outcome).toEqual({ kind: "committed", value: "row" });
    expect(ledger.appends).toEqual([{ expectedHead: 3 }]);
    // The fact is durable BEFORE the projection is touched.
    expect(ledger.order).toEqual(["append", "project"]);
  });

  test("a stale head refuses the commit and never projects", () => {
    const ledger = fakeLedger([conflict(7)]);
    let projected = false;
    const outcome = commitFact(ledger, { streamId: STREAM, expectedHead: 3, fact: FACT }, () => {
      projected = true;
      return "row" as const;
    });

    expect(outcome).toEqual({ kind: "stale_head" });
    expect(projected).toBe(false);
  });

  test("a lost projection CAS refuses the commit even though the fact appended", () => {
    const ledger = fakeLedger([committed(4)]);
    const outcome = commitFact(
      ledger,
      { streamId: STREAM, expectedHead: 3, fact: FACT },
      () => false,
    );

    // The refusal is what makes the caller's transaction roll the append
    // back; reporting `committed` here would let head outrun revision.
    expect(outcome).toEqual({ kind: "stale_head" });
    expect(ledger.appends).toHaveLength(1);
  });
});

describe("commitFact pre-cutover adoption gate", () => {
  test("adopts an empty stream under a revision >= 1 row, then retries at the same head", () => {
    const ledger = fakeLedger([conflict(0), committed(4)]);
    const outcome = commitFact(
      ledger,
      { streamId: STREAM, expectedHead: 3, fact: FACT, adoption: { genesis: GENESIS } },
      () => "row" as const,
    );

    expect(outcome).toEqual({ kind: "committed", value: "row" });
    // Genesis lands AT the observed revision, and the retry uses the same
    // expected head as the first attempt.
    expect(ledger.adoptions).toEqual([3]);
    expect(ledger.appends).toEqual([{ expectedHead: 3 }, { expectedHead: 3 }]);
    expect(ledger.order).toEqual(["append", "adopt", "append"]);
  });

  test("does NOT adopt when the stale head is non-empty: that is a genuine lost race", () => {
    const ledger = fakeLedger([conflict(9)]);
    const outcome = commitFact(
      ledger,
      { streamId: STREAM, expectedHead: 3, fact: FACT, adoption: { genesis: GENESIS } },
      () => "row" as const,
    );

    expect(outcome).toEqual({ kind: "stale_head" });
    // A stream WITH history must never receive a genesis, and must not even
    // be offered one.
    expect(ledger.adoptions).toEqual([]);
    expect(ledger.appends).toHaveLength(1);
  });

  test("does NOT adopt at expectedHead 0: an empty stream is the correct birth state", () => {
    const ledger = fakeLedger([conflict(0)]);
    const outcome = commitFact(
      ledger,
      { streamId: STREAM, expectedHead: 0, fact: FACT, adoption: { genesis: GENESIS } },
      () => "row" as const,
    );

    expect(outcome).toEqual({ kind: "stale_head" });
    expect(ledger.adoptions).toEqual([]);
  });

  test("does NOT adopt when the domain declares no adoption path", () => {
    const ledger = fakeLedger([conflict(0)]);
    const outcome = commitFact(
      ledger,
      { streamId: STREAM, expectedHead: 3, fact: FACT },
      () => "row" as const,
    );

    // A domain without an adoption path treats an empty stale head as a race.
    expect(outcome).toEqual({ kind: "stale_head" });
    expect(ledger.adoptions).toEqual([]);
    expect(ledger.appends).toHaveLength(1);
  });

  test("a losing adopter refuses the commit instead of retrying", () => {
    const ledger = fakeLedger([conflict(0)], () => {
      throw new Ledger.AdoptError({
        message: "stream wait:w-1 is not empty",
        streamId: STREAM,
        currentHead: 3,
      });
    });
    const outcome = commitFact(
      ledger,
      { streamId: STREAM, expectedHead: 3, fact: FACT, adoption: { genesis: GENESIS } },
      () => "row" as const,
    );

    expect(outcome).toEqual({ kind: "stale_head" });
    // No second append: the concurrent adopter's write is the head we lost to.
    expect(ledger.appends).toHaveLength(1);
  });

  test("a non-adoption error during adoption propagates unchanged", () => {
    const boom = new Error("disk failure");
    const ledger = fakeLedger([conflict(0)], () => {
      throw boom;
    });

    expect(() =>
      commitFact(
        ledger,
        { streamId: STREAM, expectedHead: 3, fact: FACT, adoption: { genesis: GENESIS } },
        () => "row" as const,
      ),
    ).toThrow(boom);
  });
});

describe("runCommitTransaction", () => {
  test("returns the write result through the storage transaction", () => {
    const calls: string[] = [];
    const storage = {
      transaction<R>(operation: () => R): R {
        calls.push("transaction");
        return operation();
      },
    };

    const result = runCommitTransaction(
      storage,
      () => {
        calls.push("write");
        return 42;
      },
      () => new Error("unused"),
    );

    expect(result).toBe(42);
    expect(calls).toEqual(["transaction", "write"]);
  });

  test("maps SQLITE_BUSY to the caller's typed error", () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const storage = {
      transaction<R>(): R {
        throw busy;
      },
    };
    class DomainUnavailable extends Error {}

    expect(() =>
      runCommitTransaction(
        storage,
        () => "unreachable",
        (cause) => new DomainUnavailable(`busy: ${(cause as Error).message}`),
      ),
    ).toThrow(DomainUnavailable);
  });

  test("propagates non-busy errors unchanged", () => {
    const other = new Error("constraint violation");
    const storage = {
      transaction<R>(): R {
        throw other;
      },
    };
    let mapped = false;

    expect(() =>
      runCommitTransaction(
        storage,
        () => "unreachable",
        () => {
          mapped = true;
          return new Error("should not map");
        },
      ),
    ).toThrow(other);
    expect(mapped).toBe(false);
  });
});
