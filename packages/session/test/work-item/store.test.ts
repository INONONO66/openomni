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
      detail: "bun test packages/session/test/work-item/",
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

  test("retries failed work items with a new basis and stable completion contract", async () => {
    configureSqlite();
    const item = await createItem("retry", {
      executorKind: "internal_chat_agent",
      workerRunId: "run:retry:1",
      workSessionId: "session:retry:1",
    });
    const updatedFields: string[][] = [];
    Bus.subscribe(WorkItem.Events.Updated, (event) => updatedFields.push(event.payload.fields));
    const failed = await WorkItemStore.fail(item.workItemId, "trace-test", "transient error");
    const retried = await WorkItemStore.retry(item.workItemId, "trace-test");

    expect(failed?.attempt).toBe(1);
    expect(retried?.attempt).toBe(2);
    expect(retried?.failureReason).toBeUndefined();
    expect(retried?.timestamps.failed).toBeUndefined();
    expect(retried?.timestamps.started).toBeNumber();
    expect(retried ? WorkItem.deriveStatus(retried) : undefined).toBe("running");
    expect(retried?.completionContract.revision).toBe(item.completionContract.revision);
    expect(retried?.completionContract.basisRef).not.toBe(item.completionContract.basisRef);
    expect(retried?.acceptanceCriteria).toEqual(item.acceptanceCriteria);
    expect(retried?.completionFacts.criteria).toEqual(item.completionFacts.criteria);
    expect(retried?.executorKind).toBeUndefined();
    expect(retried?.workerRunId).toBeUndefined();
    expect(retried?.workSessionId).toBeUndefined();
    expect(updatedFields).toContainEqual([
      "attempt",
      "timestamps",
      "failureReason",
      "completionContract",
      "executorKind",
      "workerRunId",
      "workSessionId",
      "attemptTerminal",
    ]);
    await expect(
      WorkItemStore.addEvidence(
        item.workItemId,
        {
          kind: "verification",
          description: "late connector artifact",
          passed: true,
        },
        "trace-test",
        {
          expectedAttempt: item.attempt,
          expectedBasisRef: item.completionContract.basisRef,
        },
      ),
    ).rejects.toThrow("attempt changed before evidence recording");
    expect(WorkItemStore.get(item.workItemId)?.evidence).toEqual([]);
    const assigned = await WorkItemStore.assignExecution(
      item.workItemId,
      {
        executorKind: "internal_chat_agent",
        workerRunId: "run:retry:2",
        workSessionId: "session:retry:2",
      },
      "trace-test",
    );
    expect(assigned).toMatchObject({
      executorKind: "internal_chat_agent",
      workerRunId: "run:retry:2",
      workSessionId: "session:retry:2",
    });
    await expect(
      WorkItemStore.assignExecution(
        item.workItemId,
        {
          executorKind: "internal_chat_agent",
          workerRunId: "run:retry:duplicate",
          workSessionId: "session:retry:duplicate",
        },
        "trace-test",
      ),
    ).rejects.toThrow("already has an execution assignment");
  });

  test("checks evidence replay scope before accepting an explicit evidence idempotently", async () => {
    configureSqlite();
    const item = await createItem("scoped-evidence-replay");
    const scope = {
      expectedAttempt: item.attempt,
      expectedBasisRef: item.completionContract.basisRef,
    };
    const evidence = {
      id: "evidence:scoped-replay",
      kind: "verification" as const,
      description: "original attempt evidence",
      passed: true,
    };

    await WorkItemStore.addEvidence(item.workItemId, evidence, "trace-test", scope);
    await WorkItemStore.fail(item.workItemId, "trace-test", "retry required");
    await WorkItemStore.retry(item.workItemId, "trace-test");

    await expect(
      WorkItemStore.addEvidence(item.workItemId, evidence, "trace-test", scope),
    ).rejects.toThrow("attempt changed before evidence recording");
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

  test("defaults internal worker items to three max attempts", async () => {
    configureSqlite();

    const item = await createItem("internal-worker-default", {
      executorKind: "internal_chat_agent",
    });

    expect(item.maxAttempts).toBe(3);
  });

  test("keeps explicit maxAttempts overrides", async () => {
    configureSqlite();

    const item = await createItem("explicit-attempts", {
      executorKind: "internal_chat_agent",
      maxAttempts: 2,
    });

    expect(item.maxAttempts).toBe(2);
  });

  test("rejects retry after max attempts and adds an Owner escalation blocker", async () => {
    configureSqlite();
    const item = await createItem("retry-exhaustion", { maxAttempts: 1 });
    await WorkItemStore.fail(item.workItemId, "trace-test", "permanent error");

    await expectRejectsWithMessage(
      WorkItemStore.retry(item.workItemId, "trace-test"),
      "retry attempts exhausted for work item",
    );

    const exhausted = WorkItemStore.get(item.workItemId);
    expect(exhausted?.attempt).toBe(1);
    expect(exhausted ? WorkItem.deriveStatus(exhausted) : undefined).toBe("failed");
    expect(exhausted?.blockers).toEqual([
      expect.objectContaining({
        kind: "waiting_input",
        description: "retry attempts exhausted after 1 attempts; Owner escalation required",
      }),
    ]);
  });

  test("allows exactly three attempts for internal worker defaults before exhaustion", async () => {
    configureSqlite();
    const item = await createItem("internal-three-attempts", {
      executorKind: "internal_chat_agent",
    });

    await WorkItemStore.fail(item.workItemId, "trace-test", "first failure");
    const secondAttempt = await WorkItemStore.retry(item.workItemId, "trace-test");
    await WorkItemStore.fail(item.workItemId, "trace-test", "second failure");
    const thirdAttempt = await WorkItemStore.retry(item.workItemId, "trace-test");
    await WorkItemStore.fail(item.workItemId, "trace-test", "third failure");

    await expectRejectsWithMessage(
      WorkItemStore.retry(item.workItemId, "trace-test"),
      "retry attempts exhausted for work item",
    );

    const exhausted = WorkItemStore.get(item.workItemId);
    expect(secondAttempt?.attempt).toBe(2);
    expect(thirdAttempt?.attempt).toBe(3);
    expect(exhausted?.attempt).toBe(3);
    expect(exhausted?.maxAttempts).toBe(3);
    expect(exhausted?.blockers).toEqual([
      expect.objectContaining({
        kind: "waiting_input",
        description: "retry attempts exhausted after 3 attempts; Owner escalation required",
      }),
    ]);
  });

  test("does not duplicate retry exhaustion blockers", async () => {
    configureSqlite();
    const item = await createItem("retry-exhaustion-idempotent", { maxAttempts: 1 });
    await WorkItemStore.fail(item.workItemId, "trace-test", "permanent error");

    await expectRejectsWithMessage(
      WorkItemStore.retry(item.workItemId, "trace-test"),
      "retry attempts exhausted for work item",
    );
    await expectRejectsWithMessage(
      WorkItemStore.retry(item.workItemId, "trace-test"),
      "retry attempts exhausted for work item",
    );

    const exhausted = WorkItemStore.get(item.workItemId);
    expect(exhausted?.blockers).toHaveLength(1);
  });

  test("keeps retry available for items without maxAttempts", async () => {
    configureSqlite();
    const item = await createItem("retry-without-max-attempts");

    await WorkItemStore.fail(item.workItemId, "trace-test", "first failure");
    const secondAttempt = await WorkItemStore.retry(item.workItemId, "trace-test");
    await WorkItemStore.fail(item.workItemId, "trace-test", "second failure");
    const thirdAttempt = await WorkItemStore.retry(item.workItemId, "trace-test");

    expect(secondAttempt?.attempt).toBe(2);
    expect(thirdAttempt?.attempt).toBe(3);
    expect(thirdAttempt ? WorkItem.deriveStatus(thirdAttempt) : undefined).toBe("running");
  });

  test("retry degrades gracefully when work item storage is missing", async () => {
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

    await expect(WorkItemStore.retry("missing", "trace-test")).resolves.toBeUndefined();
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

  test("rejects starting a failed item without retry", async () => {
    configureSqlite();
    const item = await createItem("start-failed");
    await WorkItemStore.fail(item.workItemId, "trace-test", "broken");
    await expectRejectsWithMessage(
      WorkItemStore.start(item.workItemId, "trace-test"),
      "Cannot start a failed work item",
    );
  });

  test("rejects retrying a non-failed item", async () => {
    configureSqlite();
    const item = await createItem("retry-pending");
    await expectRejectsWithMessage(
      WorkItemStore.retry(item.workItemId, "trace-test"),
      "retry() can only be called on failed work items",
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

  test("adds read-back verification evidence", async () => {
    configureSqlite();
    const item = await createItem("read-back");

    const updated = await WorkItemStore.addReadBackEvidence(
      item.workItemId,
      {
        kind: "citation_match",
        target: "https://example.com/source",
        passed: true,
        observedAt: 4,
        quotedText: "source sentence",
        matchedText: "source sentence",
      },
      "trace-test",
    );

    expect(updated?.evidence).toHaveLength(1);
    expect(updated?.evidence[0]).toMatchObject({
      kind: "verification",
      description: "citation_match read-back passed for https://example.com/source",
      passed: true,
      readBack: {
        kind: "citation_match",
        quotedText: "source sentence",
      },
    });
  });

  test("dead surface stays dead: removed store members are not exposed", () => {
    // #606 dead-surface removal — update/remove/complete/recordOutcome/
    // areDependenciesMet had zero production callers; completion goes ONLY
    // through the admission writer (Storage.configure receipt).
    for (const member of ["update", "remove", "complete", "recordOutcome", "areDependenciesMet"]) {
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
