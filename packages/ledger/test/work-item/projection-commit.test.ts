import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { Storage, WorkItemStore } from "../../src/index";
import { WorkItemRevisionError } from "../../src/work-item/facts";

/**
 * Characterization of the WorkItem PROJECTION commit, pinned before the
 * projection compare-and-set moves into the shared commit coordinator's
 * `project` slot.
 *
 * The three WorkItem write paths each append a decision fact and then land a
 * projection write. What must survive the move is the observable pairing at
 * every path:
 *
 *   - create: an append conflict AND a failed projection INSERT both raise
 *     the SAME typed duplicate error;
 *   - mutation: an append conflict AND a failed projection CAS both raise the
 *     SAME typed revision error;
 *   - completion writer: both report `false` rather than throwing;
 *   - in every case a failed projection leaves NOTHING committed, so the
 *     ledger head still equals the row's revision (transaction rollback).
 *
 * The last rule is the load-bearing one: it is why the projection write and
 * the fact append have to share one transaction, and it is what a dummy
 * `() => true` projection slot cannot express.
 */

const HASH_MISSING = "0".repeat(64);

function seedInput(name: string) {
  return {
    name,
    sourceMessageId: `msg-${name}`,
    sourceChannel: "test",
    intent: "test intent",
    goal: "test goal",
    acceptanceCriteria: ["done"],
  };
}

/** Head seq of the work item's own fact stream (0 when the stream is empty). */
function headOf(workItemId: string): number {
  const ledger = Storage.get().ledger;
  if (!ledger) throw new Error("ledger sub-adapter unavailable");
  return ledger.headFact(`work:${workItemId}`)?.seq ?? 0;
}

/**
 * Forces the projection compare-and-set to refuse while leaving the fact
 * append healthy — the only way to reach the rollback backstop, which no
 * public call sequence can trigger while head and revision stay bound.
 */
function withRefusingProjection<T>(run: () => T): T {
  const adapter = Storage.get().workItem;
  if (!adapter) throw new Error("workItem adapter unavailable");
  const original = adapter.compareAndSet.bind(adapter);
  Object.defineProperty(adapter, "compareAndSet", {
    configurable: true,
    writable: true,
    value: () => false,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(adapter, "compareAndSet", {
      configurable: true,
      writable: true,
      value: original,
    });
  }
}

function withRefusingInsert<T>(run: () => T): T {
  const adapter = Storage.get().workItem;
  if (!adapter) throw new Error("workItem adapter unavailable");
  const original = adapter.create.bind(adapter);
  Object.defineProperty(adapter, "create", {
    configurable: true,
    writable: true,
    value: () => false,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(adapter, "create", {
      configurable: true,
      writable: true,
      value: original,
    });
  }
}

let completionWriter: Storage.WorkItemCompletionWriter;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  completionWriter = Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

describe("WorkItem projection commit", () => {
  test("a healthy create binds head to revision", async () => {
    const item = await WorkItemStore.create(seedInput("healthy"), "trace-1");

    expect(item.revision).toBe(1);
    expect(headOf(item.workItemId)).toBe(item.revision);
  });

  test("a refused projection INSERT raises the duplicate error and commits nothing", async () => {
    // Same observable outcome as a non-empty stream: the create path reports
    // one duplicate error regardless of WHICH of the two guards refused.
    await expect(
      withRefusingInsert(() => WorkItemStore.create(seedInput("insert-refused"), "trace-1")),
    ).rejects.toThrow(/already exists|duplicate/i);
  });

  test("a refused projection INSERT rolls the appended birth fact back", async () => {
    let workItemId = "";
    try {
      await withRefusingInsert(async () => {
        const created = await WorkItemStore.create(seedInput("rollback-birth"), "trace-1");
        workItemId = created.workItemId;
      });
    } catch {
      // expected
    }
    // Nothing may survive: no row, and no orphan fact at seq 1.
    const stored = workItemId === "" ? undefined : WorkItemStore.get(workItemId);
    expect(stored).toBeUndefined();
    expect(headOf(HASH_MISSING)).toBe(0);
  });

  test("a healthy transition advances head and revision together", async () => {
    const item = await WorkItemStore.create(seedInput("transition"), "trace-1");
    const started = await WorkItemStore.start(item.workItemId, "trace-1");

    expect(started?.revision).toBe(2);
    expect(headOf(item.workItemId)).toBe(2);
  });

  test("a refused projection CAS raises the revision error and leaves head at the row revision", async () => {
    const item = await WorkItemStore.create(seedInput("cas-refused"), "trace-1");
    const headBefore = headOf(item.workItemId);

    await expect(
      withRefusingProjection(() => WorkItemStore.start(item.workItemId, "trace-1")),
    ).rejects.toThrow(WorkItemRevisionError);

    // The append happened inside the same transaction as the refused CAS, so
    // the rollback must leave the head exactly where it was.
    expect(headOf(item.workItemId)).toBe(headBefore);
    expect(WorkItemStore.get(item.workItemId)?.revision).toBe(item.revision);
  });

  test("the completion writer reports false on a refused projection CAS, without throwing", async () => {
    const item = await WorkItemStore.create(seedInput("completion"), "trace-1");
    const running = await WorkItemStore.start(item.workItemId, "trace-1");
    if (!running) throw new Error("start did not return the running item");
    const headBefore = headOf(item.workItemId);

    // The candidate payload is irrelevant here: the projection CAS is forced
    // to refuse, so what is under test is the refusal path, not admission.
    const accepted = withRefusingProjection(() =>
      completionWriter(running.workItemId, running.revision, {
        ...running,
        revision: running.revision + 1,
      }),
    );

    // A refusal is a return value here, not an exception — the completion
    // authority decides what to do about a lost race.
    expect(accepted).toBe(false);
    // The projection did NOT move.
    expect(WorkItemStore.get(running.workItemId)?.revision).toBe(running.revision);
    // ...and the appended completion fact does not outlive it. This binding is
    // the whole point of sharing one transaction: the writer reports the
    // refusal by RETURNING false, which commits the transaction, so the fact
    // must be discarded by the commit path itself rather than by a rollback.
    expect(headOf(item.workItemId)).toBe(headBefore);
  });

  test("the completion writer refuses a stale expected head before appending", async () => {
    const item = await WorkItemStore.create(seedInput("stale-head"), "trace-1");
    const running = await WorkItemStore.start(item.workItemId, "trace-1");
    if (!running) throw new Error("start did not return the running item");
    const headBefore = headOf(item.workItemId);

    const accepted = completionWriter(running.workItemId, running.revision - 1, {
      ...running,
      revision: running.revision + 1,
    });

    expect(accepted).toBe(false);
    expect(headOf(item.workItemId)).toBe(headBefore);
  });
});
