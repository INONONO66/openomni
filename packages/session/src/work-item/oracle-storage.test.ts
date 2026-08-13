import { afterEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { SqliteStorageAdapter } from "../storage/sqlite-storage.js";
import { Storage } from "../storage/storage.js";
import { persistCompletedWorkItemFixture } from "../../test/work-item/completed-fixture.js";
import { WorkItemStore } from "./index.js";
import { persistMutation } from "./mutation.js";

const baseInput = {
  sourceMessageId: "msg_oracle_storage",
  sourceChannel: "test",
  intent: "verify storage concurrency",
  goal: "preserve one shared WorkItem row head",
  sessionId: "session_oracle_storage",
  acceptanceCriteria: ["storage mutations preserve the winning row"],
};

let adapter: SqliteStorageAdapter | undefined;
let completionWriter: Storage.WorkItemCompletionWriter;

function configureSqlite(): SqliteStorageAdapter {
  adapter = new SqliteStorageAdapter(":memory:");
  completionWriter = Storage.configure(adapter);
  return adapter;
}

async function createItem(
  name: string,
  extra?: Partial<Parameters<typeof WorkItemStore.create>[0]>,
): Promise<WorkItem.Info> {
  return WorkItemStore.create({ ...baseInput, ...extra, name });
}

function persistCompletedFixture(item: WorkItem.Info): WorkItem.Info {
  const completionReport = WorkItem.canonicalCompletionReport({
    summary: "Oracle storage fixture completed.",
    claims: [
      {
        statement:
          item.completionFacts.criteria[0]?.statement ?? "Oracle storage fixture completed.",
        evidenceIds: [`evidence:${item.hash}:oracle-storage-fixture`],
      },
    ],
    caveats: [],
    followUps: [],
  });
  const completed = persistCompletedWorkItemFixture({
    hash: item.hash,
    report: completionReport,
    completionWriter,
  });
  if (!completed) throw new Error("failed to persist completed fixture");
  return completed;
}

async function expectRejectsWithMessage(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).toContain(message);
    return;
  }
  throw new Error(`Expected operation to reject with ${message}`);
}

afterEach(() => {
  Bus.reset();
  Storage.reset();
  adapter?.close();
  adapter = undefined;
});

describe("WorkItem oracle storage concurrency", () => {
  test("rejects completed fixtures that omit a required criterion", async () => {
    configureSqlite();
    const item = await createItem("Incomplete completion fixture", {
      acceptanceCriteria: ["First required criterion", "Second required criterion"],
    });

    expect(() =>
      persistCompletedWorkItemFixture({
        hash: item.hash,
        report: {
          summary: "Only the first criterion was claimed.",
          claims: [
            {
              statement: "First required criterion",
              evidenceIds: ["evidence:incomplete-fixture:first"],
            },
          ],
          caveats: [],
          followUps: [],
        },
        completionWriter,
      }),
    ).toThrow("completed fixture report omits required criterion");
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions).toEqual([]);
  });

  test("records Owner outcome through one shared row CAS", async () => {
    const storage = configureSqlite();
    const item = await createItem("CAS outcome");
    const completed = persistCompletedFixture(item);
    const originalCompareAndSet = storage.workItem.compareAndSet.bind(storage.workItem);
    const attemptedHeads: Array<readonly [number, number]> = [];
    storage.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (hash === item.hash) attemptedHeads.push([expectedHead, candidate.revision]);
      return originalCompareAndSet(hash, expectedHead, candidate);
    };

    const recorded = await WorkItemStore.recordOutcome(item.hash, "adopted");

    expect(attemptedHeads).toEqual([[completed.revision, completed.revision + 1]]);
    expect(recorded).toMatchObject({ revision: completed.revision + 1, outcome: "adopted" });
    expect(recorded?.completionTerminalReceipt).toEqual(completed.completionTerminalReceipt);
  });

  test("rejects a stale Owner outcome without rewinding the competing row", async () => {
    const storage = configureSqlite();
    const item = await createItem("Stale outcome");
    const completed = persistCompletedFixture(item);
    // The competing writer commits its own full append+CAS write between the
    // outcome's read and its transaction (#510 C1: a raw projection write
    // inside the loser's transaction would roll back with it).
    const originalGet = storage.workItem.get.bind(storage.workItem);
    let injectedCompetingWrite = false;
    storage.workItem.get = (hash) => {
      const current = originalGet(hash);
      if (hash === item.hash && current && !injectedCompetingWrite) {
        injectedCompetingWrite = true;
        persistMutation(
          storage.workItem,
          current,
          {
            ...current,
            name: "competing winner",
            timestamps: { ...current.timestamps, updated: current.timestamps.updated + 1 },
          },
          current.timestamps.updated + 1,
          ["name"],
          { type: "work_item.updated", data: { fields: ["name"] } },
        );
      }
      return current;
    };

    await expectRejectsWithMessage(
      WorkItemStore.recordOutcome(item.hash, "corrected"),
      `stale WorkItem revision: ${item.hash}`,
    );

    expect(injectedCompetingWrite).toBe(true);
    expect(WorkItemStore.get(item.hash)).toMatchObject({
      revision: completed.revision + 1,
      name: "competing winner",
    });
    expect(WorkItemStore.get(item.hash)?.outcome).toBeUndefined();
  });

  test("removes the inserted child when parent relation CAS loses", async () => {
    const storage = configureSqlite();
    const parent = await createItem("Raced parent");
    // Competing full write to the parent lands between create's parent read
    // and its transaction; the losing create rolls back child row, child
    // created fact, and parent link together.
    const originalGet = storage.workItem.get.bind(storage.workItem);
    let injectedCompetingWrite = false;
    storage.workItem.get = (hash) => {
      const current = originalGet(hash);
      if (hash === parent.hash && current && !injectedCompetingWrite) {
        injectedCompetingWrite = true;
        persistMutation(
          storage.workItem,
          current,
          {
            ...current,
            name: "parent race winner",
            timestamps: { ...current.timestamps, updated: current.timestamps.updated + 1 },
          },
          current.timestamps.updated + 1,
          ["name"],
          { type: "work_item.updated", data: { fields: ["name"] } },
        );
      }
      return current;
    };

    await expectRejectsWithMessage(
      createItem("Orphan candidate", { parentHash: parent.hash }),
      `stale WorkItem revision: ${parent.hash}`,
    );

    expect(injectedCompetingWrite).toBe(true);
    expect(WorkItemStore.list({ parentHash: parent.hash })).toEqual([]);
    expect(WorkItemStore.list()).toHaveLength(1);
    expect(WorkItemStore.get(parent.hash)).toMatchObject({
      revision: parent.revision + 1,
      name: "parent race winner",
      relations: { childHashes: [] },
    });
  });
});
