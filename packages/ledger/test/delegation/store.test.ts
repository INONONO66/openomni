import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delegation } from "@openomni/protocol";

const legacyDirectories: string[] = [];
import { DelegationStore, SqliteStorageAdapter, Storage } from "../../src/index";
import { createMemoryDelegationAdapter } from "./memory-delegation-adapter";
import { buildDelegationRecord } from "../helpers/delegation";
import { bareStorageAdapter } from "../helpers/wait";

const adapters = [
  {
    name: "in-memory",
    create: (): Storage.Adapter => ({
      ...bareStorageAdapter(),
      delegation: createMemoryDelegationAdapter(),
    }),
  },
  {
    name: "SQLite",
    create: (): Storage.Adapter => new SqliteStorageAdapter(":memory:"),
  },
];

for (const { name, create } of adapters) {
  describe(`DelegationStore (${name})`, () => {
    beforeEach(() => {
      Storage.reset();
      Storage.configure(create());
    });

    afterEach(() => {
      Storage.reset();
    });

    test("settles once under concurrent calls and preserves the winner", async () => {
      DelegationStore.create(buildDelegationRecord());
      const completed = Delegation.Settled.parse({
        status: "completed",
        delegationId: "delegation-1",
        output: "done",
        at: 200,
      });
      const cancelled = Delegation.Settled.parse({
        status: "cancelled",
        delegationId: "delegation-1",
        reason: "operator cancelled",
        at: 201,
      });

      const [first, second] = await Promise.all([
        Promise.resolve().then(() => DelegationStore.settle("delegation-1", completed)),
        Promise.resolve().then(() => DelegationStore.settle("delegation-1", cancelled)),
      ]);

      expect(first).toEqual(completed);
      expect(second).toEqual(completed);
      expect(DelegationStore.get("delegation-1")).toMatchObject({
        status: "settled",
        settled: completed,
        settledAt: completed.at,
      });
    });

    test("settleOnce distinguishes an equal losing CAS from the winner", () => {
      DelegationStore.create(buildDelegationRecord());
      const settlement = Delegation.Settled.parse({
        status: "completed",
        delegationId: "delegation-1",
        output: "same proposal",
        at: 200,
      });

      expect(DelegationStore.settleOnce("delegation-1", settlement)).toEqual({
        committed: true,
        settlement,
      });
      expect(DelegationStore.settleOnce("delegation-1", settlement)).toEqual({
        committed: false,
        settlement,
      });
    });

    test("records wake delivery once and lists settled delegations without a receipt", () => {
      DelegationStore.create(buildDelegationRecord());
      DelegationStore.settle("delegation-1", {
        status: "completed",
        delegationId: "delegation-1",
        output: "done",
        at: 200,
      });

      expect(DelegationStore.listSettledUnwoken().map((record) => record.delegationId)).toEqual([
        "delegation-1",
      ]);
      expect(DelegationStore.markWoken("delegation-1", 201)).toBe(true);
      expect(DelegationStore.markWoken("delegation-1", 202)).toBe(false);
      expect(DelegationStore.get("delegation-1")?.wokenAt).toBe(201);
      expect(DelegationStore.listSettledUnwoken()).toEqual([]);
    });

    test("finds a delegation by its linked Wait id after settlement", () => {
      DelegationStore.create(buildDelegationRecord());
      DelegationStore.settle("delegation-1", {
        status: "completed",
        delegationId: "delegation-1",
        output: "reply",
        at: 200,
      });

      expect(DelegationStore.findByWaitId("wait-1")).toMatchObject({
        delegationId: "delegation-1",
        status: "settled",
      });
      expect(DelegationStore.findByWaitId("wait-missing")).toBeUndefined();
    });

    test("counts only open delegations within one root", () => {
      DelegationStore.create(buildDelegationRecord());
      DelegationStore.create(
        buildDelegationRecord({
          delegationId: "delegation-2",
          waitId: "wait-2",
          rootDelegationId: "delegation-1",
          createdAt: 101,
        }),
      );
      DelegationStore.create(
        buildDelegationRecord({
          delegationId: "delegation-other",
          waitId: "wait-other",
          rootDelegationId: "delegation-other",
          createdAt: 102,
        }),
      );
      DelegationStore.settle("delegation-2", {
        status: "completed",
        delegationId: "delegation-2",
        output: "done",
        at: 200,
      });

      expect(DelegationStore.countOpenByRoot("delegation-1")).toBe(1);
      expect(DelegationStore.countOpenByRoot("delegation-other")).toBe(1);
    });

    test("atomically refuses a child claim when its required parent is settled", () => {
      DelegationStore.create(buildDelegationRecord({
        delegationId: "parent",
        waitId: "wait-parent",
        rootDelegationId: "parent",
      }));
      DelegationStore.settle("parent", {
        status: "cancelled",
        delegationId: "parent",
        reason: "parent cancelled",
        at: 200,
      });
      const child = buildDelegationRecord({
        delegationId: "child",
        waitId: "wait-child",
        parentDelegationId: "parent",
        rootDelegationId: "parent",
        origin: {
          role: "worker",
          depth: 1,
          sessionId: "session-1",
          parentDelegationId: "parent",
          rootDelegationId: "parent",
        },
      });

      expect(
        DelegationStore.claimOpenWithinRoot(child, 8, { requireOpenParent: "parent" }),
      ).toEqual({ claimed: false, reason: "parent_settled" });
      expect(DelegationStore.get("child")).toBeUndefined();
    });

    test("lists all and only open delegations in admission order", () => {
      DelegationStore.create(buildDelegationRecord());
      DelegationStore.create(
        buildDelegationRecord({
          delegationId: "delegation-2",
          waitId: "wait-2",
          createdAt: 101,
        }),
      );
      DelegationStore.settle("delegation-1", {
        status: "completed",
        delegationId: "delegation-1",
        output: "done",
        at: 200,
      });

      expect(DelegationStore.listOpen().map((record) => record.delegationId)).toEqual([
        "delegation-2",
      ]);
    });
  });
}

describe("DelegationStore legacy wake-receipt upcast (SQLite)", () => {
  beforeEach(() => {
    Storage.reset();
  });

  afterEach(() => {
    Storage.reset();
    for (const directory of legacyDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a pre-0024 settled row (NULL woken_at, JSON without wokenAt) decodes as unwoken", () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-legacy-wake-receipt-"));
    legacyDirectories.push(directory);
    const dbPath = join(directory, "legacy.db");
    Storage.configure(new SqliteStorageAdapter(dbPath));

    // Seed the pre-0024 shape directly, bypassing the current write path: the
    // additive woken_at column did not exist before migration 0024, so an old
    // settled row carries no wokenAt in its JSON payload and NULL in the
    // column. Raw SQL keeps this pin honest against write-path drift.
    const legacy = Delegation.Record.parse({
      ...buildDelegationRecord(),
      status: "settled",
      settled: {
        status: "completed",
        delegationId: "delegation-1",
        output: "done",
        at: 200,
      },
      settledAt: 200,
    });
    const raw = new Database(dbPath);
    raw
      .query(
        `INSERT INTO delegation (
           delegation_id, status, root_delegation_id, wait_id, data, time_created, settled_at, woken_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        legacy.delegationId,
        "settled",
        legacy.rootDelegationId,
        legacy.waitId ?? null,
        JSON.stringify(legacy),
        legacy.createdAt,
        200,
      );
    raw.close();

    // Missing receipt = unwoken: the NULL column upcasts to an ABSENT
    // wokenAt, never a fabricated one, so boot recovery re-delivers the wake.
    const decoded = DelegationStore.get("delegation-1");
    expect(decoded?.status).toBe("settled");
    expect(decoded?.wokenAt).toBeUndefined();
    expect(DelegationStore.listSettledUnwoken().map((record) => record.delegationId)).toEqual([
      "delegation-1",
    ]);

    // The receipt CAS treats the row as unwoken and stamps it exactly once.
    expect(DelegationStore.markWoken("delegation-1", 201)).toBe(true);
    expect(DelegationStore.markWoken("delegation-1", 202)).toBe(false);
    expect(DelegationStore.get("delegation-1")?.wokenAt).toBe(201);
    expect(DelegationStore.listSettledUnwoken()).toEqual([]);
  });
});

describe("DelegationStore fail-closed floor", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.configure(bareStorageAdapter());
  });

  afterEach(() => {
    Storage.reset();
  });

  test("refuses writes when the delegation sub-adapter is absent", () => {
    expect(() => DelegationStore.create(buildDelegationRecord())).toThrow(
      "Storage adapter does not implement delegation",
    );
  });
});
