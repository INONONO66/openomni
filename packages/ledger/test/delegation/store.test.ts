import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Delegation } from "@openomni/protocol";
import { DelegationStore, SqliteStorageAdapter, Storage } from "../../src/index";
import { createMemoryDelegationAdapter } from "../../src/storage/memory-delegation-adapter";
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
