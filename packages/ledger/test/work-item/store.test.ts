import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { ZodError } from "zod";
import { Bus } from "@openomni/telemetry";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage.js";
import { Storage } from "../../src/storage/storage.js";
import { WorkItemStore } from "../../src/work-item/index.js";
import { persistCompletedWorkItemFixture } from "./completed-fixture.js";

const baseInput = {
  sourceMessageId: "msg_1",
  sourceChannel: "test",
  intent: "implement",
  goal: "verify work-item store behavior",
  sessionId: "session_1",
  acceptanceCriteria: ["the requested behavior is verified"],
};

const adapters: SqliteStorageAdapter[] = [];
let completionWriter: Storage.WorkItemCompletionWriter;

function configureSqlite(): SqliteStorageAdapter {
  const adapter = new SqliteStorageAdapter(":memory:");
  adapters.push(adapter);
  completionWriter = Storage.configure(adapter);
  return adapter;
}

async function flushBus(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function createItem(
  name: string,
  extra?: Partial<Parameters<typeof WorkItemStore.create>[0]>,
) {
  return WorkItemStore.create({ ...baseInput, ...extra, name }, "trace-test");
}

async function expectRejectsWithMessage(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) return;
    expect(err.message).toContain(message);
    return;
  }
  throw new Error(`Expected operation to reject with ${message}`);
}

async function addPassingEvidence(hash: string): Promise<string> {
  const updated = await WorkItemStore.addEvidence(
    hash,
    {
      kind: "test_result",
      description: "targeted lifecycle test passed",
      passed: true,
      detail: "bun test packages/ledger/test/work-item/",
    },
    "trace-test",
  );
  const evidenceId = updated?.evidence.at(-1)?.id;
  if (!evidenceId) throw new Error("expected evidence id");
  return evidenceId;
}

function completionReport(evidenceId: string): WorkItem.CompletionReport {
  return {
    summary: "Completed with ledger evidence.",
    claims: [{ statement: "the requested behavior is verified", evidenceIds: [evidenceId] }],
    caveats: [],
    followUps: [],
  };
}

function persistCompletedFixture(
  hash: string,
  report: WorkItem.CompletionReport,
): WorkItem.Info | undefined {
  return persistCompletedWorkItemFixture({ hash, report, completionWriter });
}

afterEach(() => {
  Bus.reset();
  Storage.reset();
  for (const adapter of adapters.splice(0)) {
    adapter.close();
  }
});

describe("WorkItemStore", () => {
  test("publishes non-terminal lifecycle events and reads a completed storage fixture", async () => {
    configureSqlite();
    const events: string[] = [];
    Bus.subscribe(WorkItem.Events.Created, () => events.push("created"));
    Bus.subscribe(WorkItem.Events.StatusChanged, (event) =>
      events.push(`status:${event.payload.from}->${event.payload.to}`),
    );
    const item = await createItem("lifecycle");
    const started = await WorkItemStore.start(item.workItemId, "trace-test");
    const evidenceId = await addPassingEvidence(item.workItemId);
    const withEvidence = WorkItemStore.get(item.workItemId);
    const completed = persistCompletedFixture(item.workItemId, completionReport(evidenceId));
    await flushBus();

    expect(started).toBeDefined();
    expect(withEvidence?.evidence).toHaveLength(1);
    expect(completed).toBeDefined();
    expect(completed ? WorkItem.deriveStatus(completed) : undefined).toBe("completed");
    expect(events).toEqual(["created", "status:pending->running"]);
    expect(completed?.completionTerminalReceipt?.admissionId).toBe(
      completed?.completionFacts.admissions[0]?.id,
    );
  });

  test("owner facts bind lifecycle sequence, revision, head, and compact terminal payload", async () => {
    configureSqlite();
    const item = await createItem("owner-fact-sequence");
    await WorkItemStore.start(item.workItemId, "trace-test");
    const blocked = await WorkItemStore.addBlocker(
      item.workItemId,
      { kind: "external", description: "awaiting result" },
      "trace-test",
    );
    const blockerId = blocked?.blockers[0]?.id;
    if (!blockerId) throw new Error("missing blocker");
    await WorkItemStore.resolveBlocker(item.workItemId, blockerId, "trace-test");
    const failed = await WorkItemStore.fail(item.workItemId, "trace-test", "expected failure");
    const ledger = Storage.get().ledger;
    if (!ledger || !failed) throw new Error("missing ledger or projection");
    const types = [
      "work_item.created",
      "work_item.started",
      "work_item.blocker_added",
      "work_item.blocker_resolved",
      "work_item.failed",
    ];
    const facts = types
      .flatMap((type) => ledger.factsByType(type))
      .filter((fact) => fact.streamId === `work:${item.workItemId}`)
      .sort((a, b) => a.seq - b.seq);

    expect(facts.map(({ seq, type }) => [seq, type])).toEqual(
      types.map((type, index) => [index + 1, type]),
    );
    expect(ledger.headFact(`work:${item.workItemId}`)?.seq).toBe(failed.revision);
    expect(facts.at(-1)?.data).toMatchObject({ reason: "expected failure", revision: 5 });
    expect(facts.at(-1)?.data).not.toHaveProperty("acceptanceCriteria");
    expect(facts.at(-1)?.data).not.toHaveProperty("completionFacts");
  });

  test("stale append preserves the competing winner and emits no losing event", async () => {
    const adapter = configureSqlite();
    const item = await createItem("stale-append");
    const originalGet = adapter.workItem.get.bind(adapter.workItem);
    let injected = false;
    adapter.workItem.get = (hash) => {
      const current = originalGet(hash);
      if (hash === item.workItemId && current && !injected) {
        injected = true;
        adapter.transaction(() => {
          const appended = adapter.ledger.append(
            {
              streamId: `work:${hash}`,
              type: "work_item.updated",
              data: { fields: ["name"], revision: 2 },
            },
            1,
          );
          if (
            appended.kind !== "appended" ||
            !adapter.workItem.compareAndSet(hash, 1, { ...current, name: "winner", revision: 2 })
          ) {
            throw new Error("competing write failed");
          }
        });
      }
      return current;
    };
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    await expect(WorkItemStore.fail(item.workItemId, "trace-test", "loser")).rejects.toMatchObject({
      code: "stale_revision",
    });
    expect(originalGet(item.workItemId)).toMatchObject({ name: "winner", revision: 2 });
    expect(adapter.ledger.headFact(`work:${item.workItemId}`)).toMatchObject({
      seq: 2,
      type: "work_item.updated",
    });
    await flushBus();
    expect(events).not.toContain("work_item.failed");
    expect(events).not.toContain("work_item.status_changed");
  });

  test("adopts a pre-cutover revision at its observed snapshot before transition", async () => {
    const adapter = configureSqlite();
    const item = await createItem("lazy-adoption");
    const started = await WorkItemStore.start(item.workItemId, "trace-test");
    if (!started) throw new Error("missing started projection");
    const db = (adapter as unknown as { db: Database }).db;
    db.query("DELETE FROM ledger_event WHERE stream_id = ?").run(`work:${item.workItemId}`);
    db.query("DELETE FROM ledger_head WHERE stream_id = ?").run(`work:${item.workItemId}`);

    const failed = await WorkItemStore.fail(item.workItemId, "trace-test", "after adoption");
    const adopted = adapter.ledger
      .factsByType("work_item.adopted")
      .find((fact) => fact.streamId === `work:${item.workItemId}`);
    expect(adopted).toMatchObject({ seq: 2, data: { revision: 2 } });
    expect(adopted?.data).toMatchObject({ snapshot: { workItemId: item.workItemId, revision: 2 } });
    expect(adapter.ledger.headFact(`work:${item.workItemId}`)).toMatchObject({
      seq: failed?.revision,
      type: "work_item.failed",
    });
    expect(adapter.ledger.verifyTail()).toEqual([]);
  });

  test("a throwing subscriber observes the durable head and cannot unwind a transition", async () => {
    const adapter = configureSqlite();
    const item = await createItem("lossy-bus");
    const observedHeads: number[] = [];
    Bus.subscribe(WorkItem.Events.StatusChanged, () => {
      observedHeads.push(adapter.ledger.headFact(`work:${item.workItemId}`)?.seq ?? -1);
      throw new Error("subscriber crashed");
    });

    const started = await WorkItemStore.start(item.workItemId, "trace-test");
    if (!started) throw new Error("missing started projection");
    await flushBus();
    expect(adapter.ledger.headFact(`work:${item.workItemId}`)).toMatchObject({
      seq: started.revision,
      type: "work_item.started",
    });
    expect(observedHeads).toEqual([started.revision]);
  });

  test("D11 pin: every publish of one state transition carries the caller's ONE traceId", async () => {
    configureSqlite();
    const traces: Array<{ event: string; traceId: string }> = [];
    Bus.subscribe(WorkItem.Events.Created, (event) =>
      traces.push({ event: "created", traceId: event.traceId }),
    );
    Bus.subscribe(WorkItem.Events.StatusChanged, (event) =>
      traces.push({
        event: `status:${event.payload.from}->${event.payload.to}`,
        traceId: event.traceId,
      }),
    );
    Bus.subscribe(WorkItem.Events.Updated, (event) =>
      traces.push({ event: "updated", traceId: event.traceId }),
    );
    Bus.subscribe(WorkItem.Events.Failed, (event) =>
      traces.push({ event: "failed", traceId: event.traceId }),
    );

    const item = await WorkItemStore.create({ ...baseInput, name: "trace-funnel" }, "trace-create");
    await WorkItemStore.start(item.workItemId, "trace-start");
    await WorkItemStore.fail(item.workItemId, "trace-fail", "deliberate failure");
    await flushBus();

    expect(traces).toEqual([
      { event: "created", traceId: "trace-create" },
      // ONE start = ONE id across both projections (was 2 mints before D11).
      { event: "status:pending->running", traceId: "trace-start" },
      { event: "updated", traceId: "trace-start" },
      // ONE fail = ONE id across StatusChanged, the afterPublish Failed
      // callback, and Updated (was 3 mints before D11).
      { event: "status:running->failed", traceId: "trace-fail" },
      { event: "failed", traceId: "trace-fail" },
      { event: "updated", traceId: "trace-fail" },
    ]);
  });

  test("D11 pin: create's parent link shares the call's traceId", async () => {
    configureSqlite();
    const traces: Array<{ event: string; traceId: string }> = [];
    Bus.subscribe(WorkItem.Events.Created, (event) =>
      traces.push({ event: `created:${event.payload.workItemId}`, traceId: event.traceId }),
    );
    Bus.subscribe(WorkItem.Events.Updated, (event) =>
      traces.push({ event: `updated:${event.payload.workItemId}`, traceId: event.traceId }),
    );

    const parent = await WorkItemStore.create({ ...baseInput, name: "trace-parent" }, "trace-p");
    const child = await WorkItemStore.create(
      { ...baseInput, name: "trace-child", parentId: parent.workItemId },
      "trace-c",
    );
    await flushBus();

    expect(traces).toEqual([
      { event: `created:${parent.workItemId}`, traceId: "trace-p" },
      // ONE create = ONE id: the parent-link Updated rides the child create.
      { event: `updated:${parent.workItemId}`, traceId: "trace-c" },
      { event: `created:${child.workItemId}`, traceId: "trace-c" },
    ]);
  });

  test("requires nonempty acceptance criteria when creating a WorkItem", async () => {
    configureSqlite();

    try {
      await WorkItemStore.create(
        {
          ...baseInput,
          name: "missing-criteria",
          acceptanceCriteria: [],
        },
        "trace-test",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      if (!(error instanceof ZodError)) throw error;
      expect(error.issues.map(({ path }) => path[0])).toContain("acceptanceCriteria");
      return;
    }
    throw new Error("expected empty acceptanceCriteria to be rejected");
  });

  test("increments the shared WorkItem row revision once for an ordinary mutation", async () => {
    configureSqlite();
    const item = await createItem("shared-row-revision");

    const updated = await WorkItemStore.addEvidence(
      item.workItemId,
      {
        kind: "verification",
        description: "ordinary mutation for the shared-row revision pin",
        passed: true,
      },
      "trace-test",
    );

    expect(item).toMatchObject({ revision: 1 });
    expect(updated).toMatchObject({ revision: 2 });
    expect(updated?.completionFacts.revision).toBe(item.completionFacts.revision);
  });

  test("blocks and resumes when blockers are resolved", async () => {
    configureSqlite();
    const statuses: string[] = [];
    Bus.subscribe(WorkItem.Events.StatusChanged, (event) =>
      statuses.push(`${event.payload.from}->${event.payload.to}`),
    );

    const item = await createItem("blocker-flow");
    await WorkItemStore.start(item.workItemId, "trace-test");
    const blocked = await WorkItemStore.addBlocker(
      item.workItemId,
      {
        kind: "waiting_input",
        description: "needs user confirmation",
      },
      "trace-test",
    );
    const blocker = blocked?.blockers[0];
    const resumed = await WorkItemStore.resolveBlocker(
      item.workItemId,
      blocker?.id ?? "missing",
      "trace-test",
    );
    await flushBus();

    expect(blocked ? WorkItem.deriveStatus(blocked) : undefined).toBe("blocked");
    expect(resumed ? WorkItem.deriveStatus(resumed) : undefined).toBe("running");
    expect(statuses).toEqual(["pending->running", "running->blocked", "blocked->running"]);
  });

  test("rejects failing a completed item", async () => {
    configureSqlite();
    const item = await createItem("complete-then-fail");

    const evidenceId = await addPassingEvidence(item.workItemId);
    persistCompletedFixture(item.workItemId, completionReport(evidenceId));

    await expectRejectsWithMessage(
      WorkItemStore.fail(item.workItemId, "trace-test"),
      "Cannot fail a completed work item",
    );
  });

  test("assigns execution once and refuses replacement", async () => {
    configureSqlite();
    const item = await createItem("execution-assignment");
    const assigned = await WorkItemStore.assignExecution(
      item.workItemId,
      {
        executorKind: "internal_chat_agent",
        workerRunId: "run:assignment",
        workSessionId: "session:assignment",
      },
      "trace-test",
    );

    expect(assigned).toMatchObject({
      executorKind: "internal_chat_agent",
      workerRunId: "run:assignment",
      workSessionId: "session:assignment",
    });
    await expect(
      WorkItemStore.assignExecution(
        item.workItemId,
        {
          executorKind: "internal_chat_agent",
          workerRunId: "run:replacement",
          workSessionId: "session:replacement",
        },
        "trace-test",
      ),
    ).rejects.toThrow("already has an execution assignment");
  });

  test.each([
    "failed",
    "cancelled",
    "completed",
  ] as const)("rejects execution assignment for a terminal %s work item", async (terminalState) => {
    configureSqlite();
    const item = await createItem(`terminal-assignment-${terminalState}`);
    if (terminalState === "failed") {
      await WorkItemStore.fail(item.workItemId, "trace-test", "terminal failure");
    } else if (terminalState === "cancelled") {
      await WorkItemStore.cancel(item.workItemId, "trace-test");
    } else {
      const evidenceId = await addPassingEvidence(item.workItemId);
      persistCompletedFixture(item.workItemId, completionReport(evidenceId));
    }

    await expect(
      WorkItemStore.assignExecution(
        item.workItemId,
        {
          executorKind: "internal_chat_agent",
          workerRunId: `run:${terminalState}`,
          workSessionId: `session:${terminalState}`,
        },
        "trace-test",
      ),
    ).rejects.toThrow(`Cannot assign execution to a ${terminalState} work item`);
  });

  test("keeps explicit maxAttempts overrides", async () => {
    configureSqlite();

    const item = await createItem("explicit-attempts", {
      executorKind: "internal_chat_agent",
      maxAttempts: 2,
    });

    expect(item.maxAttempts).toBe(2);
  });

  test("refuses to fabricate a work item when storage is missing (#606)", async () => {
    Storage.configure({
      transaction: (operation) => operation(),
      session: {
        get: () => undefined,
        set: () => undefined,
        list: () => [],
        remove: () => false,
      },
      message: {
        get: () => undefined,
        set: () => undefined,
        list: () => [],
        remove: () => false,
      },
      part: {
        get: () => undefined,
        set: () => undefined,
        list: () => [],
        remove: () => false,
      },
    });

    // The old "graceful" path returned a phantom Info that was never
    // persisted — a hash indistinguishable from a real create. WorkItem
    // writes fail closed (facts.ts); creation is a write.
    await expect(createItem("graceful")).rejects.toThrow("refusing to fabricate");
  });

  test("rejects starting a failed item", async () => {
    configureSqlite();
    const item = await createItem("start-failed");
    await WorkItemStore.fail(item.workItemId, "trace-test", "broken");
    await expectRejectsWithMessage(
      WorkItemStore.start(item.workItemId, "trace-test"),
      "Cannot start a failed work item",
    );
  });

  test("rejects inconsistent read-back evidence", async () => {
    configureSqlite();
    const item = await createItem("inconsistent-read-back");

    await expectRejectsWithMessage(
      WorkItemStore.addEvidence(
        item.workItemId,
        {
          kind: "verification",
          description: "inconsistent read-back",
          passed: true,
          readBack: {
            kind: "url_fetch",
            target: "https://example.com/post",
            passed: false,
            observedAt: 2,
            statusCode: 404,
          },
        },
        "trace-test",
      ),
      "readBack.passed must match evidence.passed",
    );
  });

  test("dead surface stays dead: removed store members are not exposed", () => {
    // #606 dead-surface removal — update/remove/complete/recordOutcome/
    // areDependenciesMet had zero production callers; completion goes ONLY
    // through the admission writer (Storage.configure receipt).
    // recordEffect / addReadBackEvidence: the #492 effect projection and the
    // read-back convenience writer lost their last production callers when the
    // old product kernel was decommissioned (#797); evidence with a readBack
    // payload still flows through addEvidence, which owns the consistency check.
    for (const member of [
      "update",
      "remove",
      "complete",
      "recordOutcome",
      "areDependenciesMet",
      "recordEffect",
      "addReadBackEvidence",
      "retry",
    ]) {
      expect(Reflect.get(WorkItemStore, member)).toBeUndefined();
    }
  });

  test("publishes bus events after adapter writes", async () => {
    const adapter = configureSqlite();
    const order: string[] = [];
    const originalCreate = adapter.workItem.create.bind(adapter.workItem);
    adapter.workItem.create = (hash, item) => {
      const created = originalCreate(hash, item);
      if (created) order.push(`write:${hash}`);
      return created;
    };
    Bus.subscribe(WorkItem.Events.Created, (event) =>
      order.push(`event:${event.payload.workItemId}`),
    );

    const item = await createItem("event-order");
    await flushBus();

    expect(order).toEqual([`write:${item.workItemId}`, `event:${item.workItemId}`]);
  });
});
