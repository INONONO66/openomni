import { afterEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage.js";
import { Storage } from "../../src/storage/storage.js";
import { WorkItemStore } from "../../src/work-item/index.js";
import { persistMutation } from "../../src/work-item/mutation.js";
import { persistCompletedWorkItemFixture } from "./completed-fixture.js";

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
  return WorkItemStore.create({ ...baseInput, ...extra, name }, "trace-test");
}

function persistCompletedFixture(item: WorkItem.Info): WorkItem.Info {
  const completionReport = WorkItem.canonicalCompletionReport({
    summary: "Oracle storage fixture completed.",
    claims: [
      {
        statement:
          item.completionFacts.criteria[0]?.statement ?? "Oracle storage fixture completed.",
        evidenceIds: [`evidence:${item.workItemId}:oracle-storage-fixture`],
      },
    ],
    caveats: [],
    followUps: [],
  });
  const completed = persistCompletedWorkItemFixture({
    hash: item.workItemId,
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
        hash: item.workItemId,
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
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
  });

  test("records a mutation through one shared row CAS", async () => {
    const storage = configureSqlite();
    const item = await createItem("CAS mutation");
    const completed = persistCompletedFixture(item);
    const originalCompareAndSet = storage.workItem.compareAndSet.bind(storage.workItem);
    const attemptedHeads: Array<readonly [number, number]> = [];
    storage.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (hash === item.workItemId) attemptedHeads.push([expectedHead, candidate.revision]);
      return originalCompareAndSet(hash, expectedHead, candidate);
    };

    const recorded = await WorkItemStore.addBlocker(
      item.workItemId,
      { kind: "waiting_input", description: "owner follow-up" },
      "trace-test",
    );

    expect(attemptedHeads).toEqual([[completed.revision, completed.revision + 1]]);
    expect(recorded).toMatchObject({ revision: completed.revision + 1 });
    expect(recorded?.blockers).toHaveLength(1);
    expect(recorded?.completionTerminalReceipt).toEqual(completed.completionTerminalReceipt);
  });

  test("rejects a stale mutation without rewinding the competing row", async () => {
    const storage = configureSqlite();
    const item = await createItem("Stale mutation");
    const completed = persistCompletedFixture(item);
    // The competing writer commits its own full append+CAS write between the
    // mutation's read and its transaction (#510 C1: a raw projection write
    // inside the loser's transaction would roll back with it).
    const originalGet = storage.workItem.get.bind(storage.workItem);
    let injectedCompetingWrite = false;
    storage.workItem.get = (hash) => {
      const current = originalGet(hash);
      if (hash === item.workItemId && current && !injectedCompetingWrite) {
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
          "trace-test",
        );
      }
      return current;
    };

    await expectRejectsWithMessage(
      WorkItemStore.addBlocker(
        item.workItemId,
        { kind: "waiting_input", description: "loses the race" },
        "trace-test",
      ),
      `stale WorkItem revision: ${item.workItemId}`,
    );

    expect(injectedCompetingWrite).toBe(true);
    expect(WorkItemStore.get(item.workItemId)).toMatchObject({
      revision: completed.revision + 1,
      name: "competing winner",
    });
    expect(WorkItemStore.get(item.workItemId)?.blockers).toEqual([]);
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
      if (hash === parent.workItemId && current && !injectedCompetingWrite) {
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
          "trace-test",
        );
      }
      return current;
    };

    await expectRejectsWithMessage(
      createItem("Orphan candidate", { parentId: parent.workItemId }),
      `stale WorkItem revision: ${parent.workItemId}`,
    );

    expect(injectedCompetingWrite).toBe(true);
    expect(WorkItemStore.list({ parentId: parent.workItemId })).toEqual([]);
    expect(WorkItemStore.list()).toHaveLength(1);
    expect(WorkItemStore.get(parent.workItemId)).toMatchObject({
      revision: parent.revision + 1,
      name: "parent race winner",
      relations: { childIds: [] },
    });
  });
});
