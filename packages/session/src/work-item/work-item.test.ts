import { afterEach, describe, expect, test } from "bun:test";
import { Operational, WorkItem } from "@openomni/protocol";
import { ZodError } from "zod";
import { Bus } from "../bus/index.js";
import { SqliteStorageAdapter } from "../storage/sqlite-storage.js";
import { Storage } from "../storage/storage.js";
import { WorkItemStore } from "./index.js";

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
  return WorkItemStore.create({ ...baseInput, ...extra, name });
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
  const updated = await WorkItemStore.addEvidence(hash, {
    kind: "test_result",
    description: "targeted lifecycle test passed",
    passed: true,
    detail: "bun test packages/session/src/work-item/",
  });
  const evidenceId = updated?.evidence.at(-1)?.id;
  if (!evidenceId) throw new Error("expected evidence id");
  return evidenceId;
}

function completionReport(evidenceId: string): WorkItem.CompletionReport {
  return {
    summary: "Completed with ledger evidence.",
    claims: [{ statement: "The work happened.", evidenceIds: [evidenceId] }],
    caveats: [],
    followUps: [],
  };
}

function persistCompletedFixture(
  hash: string,
  report: WorkItem.CompletionReport,
): WorkItem.Info | undefined {
  const adapter = Storage.get().workItem;
  const current = adapter?.get(hash);
  if (!adapter || !current) return undefined;
  const admission = WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${hash}:${current.revision + 1}:session-fixture`,
    requestId: `completion-request:${hash}:${current.revision}:session-fixture`,
    requestSnapshot: WorkItem.CompletionRequest.parse({
      version: 1,
      id: `completion-request:${hash}:${current.revision}:session-fixture`,
      origin: "recovery",
      workItemHash: hash,
      contractRevision: current.completionContract.revision,
      basisRef: current.completionContract.basisRef,
      expectedHead: current.revision,
      claims: [],
      observations: [],
      results: [],
      invalidations: [],
      verificationErrors: [],
      effects: [],
    }),
    origin: "recovery",
    contractRevision: current.completionContract.revision,
    basisRef: current.completionContract.basisRef,
    effectiveResultIds: [],
    unresolvedCriterionIds: [],
    decision: "admit",
    reasonCodes: ["session_storage_fixture"],
    residualRisks: [],
    policyRef: "policy:session-storage-fixture",
    expectedHead: current.revision,
    recordedHead: current.revision + 1,
    createdAt: current.timestamps.updated + 1,
  });
  const admitted = WorkItem.Info.parse({
    ...current,
    revision: admission.recordedHead,
    completionFacts: {
      ...current.completionFacts,
      revision: current.completionFacts.revision + 1,
      admissions: [...current.completionFacts.admissions, admission],
    },
    timestamps: { ...current.timestamps, updated: admission.createdAt },
  });
  if (!completionWriter(hash, current.revision, admitted)) {
    return undefined;
  }
  const completedAt = admission.createdAt + 1;
  const completed = WorkItem.Info.parse({
    ...admitted,
    revision: admitted.revision + 1,
    completionReport: report,
    completionTerminalReceipt: {
      version: 1,
      hash,
      requestId: admission.requestId,
      admissionId: admission.id,
      contractRevision: admission.contractRevision,
      basisRef: admission.basisRef,
      recordedHead: admitted.revision + 1,
    },
    timestamps: { ...admitted.timestamps, completed: completedAt, updated: completedAt },
  });
  return completionWriter(hash, admitted.revision, completed) ? completed : undefined;
}

async function rawCompletionCode(
  hash: string,
  report: WorkItem.CompletionReport,
): Promise<unknown> {
  try {
    await WorkItemStore.complete(hash, report);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (typeof error !== "object" || error === null) throw error;
    return Reflect.get(error, "code");
  }
  return undefined;
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
    const started = await WorkItemStore.start(item.hash);
    const evidenceId = await addPassingEvidence(item.hash);
    const withEvidence = WorkItemStore.get(item.hash);
    const completed = persistCompletedFixture(item.hash, completionReport(evidenceId));
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

  test("records Owner outcome feedback for completed work items", async () => {
    configureSqlite();
    const events: string[] = [];
    Bus.subscribe(WorkItem.Events.OutcomeRecorded, (event) =>
      events.push(`${event.payload.hash}:${event.payload.outcome}`),
    );
    Bus.subscribe(WorkItem.Events.Updated, (event) =>
      events.push(`updated:${event.payload.fields.join(",")}`),
    );

    const item = await createItem("owner-outcome");
    const evidenceId = await addPassingEvidence(item.hash);
    persistCompletedFixture(item.hash, completionReport(evidenceId));

    const recorded = await WorkItemStore.recordOutcome(item.hash, "corrected");
    await flushBus();

    expect(recorded?.outcome).toBe("corrected");
    expect(WorkItemStore.get(item.hash)?.outcome).toBe("corrected");
    expect(events).toContain(`${item.hash}:corrected`);
    expect(events).toContain("updated:outcome");
  });

  test("rejects Owner outcome feedback before completion", async () => {
    configureSqlite();
    const item = await createItem("premature-outcome");

    await expectRejectsWithMessage(
      WorkItemStore.recordOutcome(item.hash, "adopted"),
      "Cannot record outcome for a pending work item",
    );
  });

  test("requires the outcome lifecycle helper instead of direct updates", async () => {
    configureSqlite();
    const item = await createItem("direct-outcome-update");

    await expectRejectsWithMessage(
      WorkItemStore.update(item.hash, { outcome: "adopted" }),
      'Use lifecycle helpers instead of update() for "outcome"',
    );
  });

  test("requires nonempty acceptance criteria when creating a WorkItem", async () => {
    configureSqlite();

    try {
      await WorkItemStore.create({
        ...baseInput,
        name: "missing-criteria",
        acceptanceCriteria: [],
      });
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

    const updated = await WorkItemStore.update(item.hash, { name: "shared-row-revision-updated" });

    expect(item).toMatchObject({ revision: 0 });
    expect(updated).toMatchObject({ revision: 1 });
    expect(updated?.completionFacts.revision).toBe(item.completionFacts.revision);
  });

  const immutableUpdates: ReadonlyArray<
    readonly [string, (item: WorkItem.Info) => Partial<Omit<WorkItem.Info, "hash">>]
  > = [
    ["acceptance criteria", () => ({ acceptanceCriteria: ["replacement"] })],
    [
      "completion contract",
      () => ({
        completionContract: {
          version: 1,
          revision: "contract:replacement",
          basisRef: "basis:replacement",
        },
      }),
    ],
    [
      "completion facts",
      (item) => ({
        completionFacts: { ...item.completionFacts, revision: item.completionFacts.revision + 1 },
      }),
    ],
    [
      "legacy completion report archive",
      () => ({
        completionReport: {
          summary: "Replacement archive.",
          claims: [{ statement: "replacement", evidenceIds: ["evidence:replacement"] }],
          caveats: [],
          followUps: [],
        },
      }),
    ],
    [
      "legacy verification gate archive",
      () => ({ verificationGate: { acceptance: { passed: true, criteria: [] } } }),
    ],
    [
      "terminal receipt",
      (item) => ({
        name: item.name,
        completionTerminalReceipt: {
          version: 1,
          hash: item.hash,
          requestId: "completion-request:replacement",
          admissionId: "admission:replacement",
          contractRevision: item.completionContract.revision,
          basisRef: item.completionContract.basisRef,
          recordedHead: 1,
        },
      }),
    ],
    ["retry limit", () => ({ maxAttempts: 99 })],
    ["Worker run identity", () => ({ workerRunId: "run_reassigned" })],
    ["Worker session identity", () => ({ workSessionId: "session_reassigned" })],
  ];

  test.each(
    immutableUpdates,
  )("rejects update rewrites of immutable %s", async (_field, replacement) => {
    configureSqlite();
    const item = await createItem(`immutable-${_field}`);

    await expect(WorkItemStore.update(item.hash, replacement(item))).rejects.toThrow();
  });

  test("records the latest Owner outcome when feedback changes", async () => {
    configureSqlite();
    const outcomes: WorkItem.Outcome[] = [];
    Bus.subscribe(WorkItem.Events.OutcomeRecorded, (event) => outcomes.push(event.payload.outcome));

    const item = await createItem("owner-outcome-update");
    const evidenceId = await addPassingEvidence(item.hash);
    persistCompletedFixture(item.hash, completionReport(evidenceId));
    await WorkItemStore.recordOutcome(item.hash, "adopted");
    const updated = await WorkItemStore.recordOutcome(item.hash, "corrected");
    await flushBus();

    expect(updated?.outcome).toBe("corrected");
    expect(WorkItemStore.get(item.hash)?.outcome).toBe("corrected");
    expect(outcomes).toEqual(["adopted", "corrected"]);
  });

  test("blocks and resumes when blockers are resolved", async () => {
    configureSqlite();
    const statuses: string[] = [];
    Bus.subscribe(WorkItem.Events.StatusChanged, (event) =>
      statuses.push(`${event.payload.from}->${event.payload.to}`),
    );

    const item = await createItem("blocker-flow");
    await WorkItemStore.start(item.hash);
    const blocked = await WorkItemStore.addBlocker(item.hash, {
      kind: "waiting_input",
      description: "needs user confirmation",
    });
    const blocker = blocked?.blockers[0];
    const resumed = await WorkItemStore.resolveBlocker(item.hash, blocker?.id ?? "missing");
    await flushBus();

    expect(blocked ? WorkItem.deriveStatus(blocked) : undefined).toBe("blocked");
    expect(resumed ? WorkItem.deriveStatus(resumed) : undefined).toBe("running");
    expect(statuses).toEqual(["pending->running", "running->blocked", "blocked->running"]);
  });

  test("derives dependency readiness across failure, retry, and completion", async () => {
    configureSqlite();
    const dependency = await createItem("dependency");
    const dependent = await createItem("dependent", { dependsOn: [dependency.hash] });

    expect(WorkItemStore.areDependenciesMet(dependent.hash)).toEqual({
      met: false,
      reason: "pending",
    });

    await WorkItemStore.fail(dependency.hash, "build failed");
    expect(WorkItemStore.areDependenciesMet(dependent.hash)).toEqual({
      met: false,
      reason: "failed",
    });

    await WorkItemStore.retry(dependency.hash);
    const evidenceId = await addPassingEvidence(dependency.hash);
    persistCompletedFixture(dependency.hash, completionReport(evidenceId));

    expect(WorkItemStore.areDependenciesMet(dependent.hash)).toEqual({
      met: true,
      reason: "all_complete",
    });
  });

  test("rejects circular dependency updates", async () => {
    configureSqlite();
    const first = await createItem("cycle-a");
    const second = await createItem("cycle-b", { dependsOn: [first.hash] });

    await expectRejectsWithMessage(
      WorkItemStore.update(first.hash, {
        relations: { ...first.relations, dependsOn: [second.hash] },
      }),
      "Circular dependency detected",
    );
  });

  test("rejects raw completion of a failed item without mutation", async () => {
    configureSqlite();
    const item = await createItem("fail-then-complete");
    const evidenceId = await addPassingEvidence(item.hash);
    await WorkItemStore.fail(item.hash, "broken");
    const before = WorkItemStore.get(item.hash);

    const code = await rawCompletionCode(item.hash, completionReport(evidenceId));

    expect(code).toBe("admission_required");
    expect(WorkItemStore.get(item.hash)).toEqual(before);
  });

  test("rejects failing a completed item", async () => {
    configureSqlite();
    const item = await createItem("complete-then-fail");

    const evidenceId = await addPassingEvidence(item.hash);
    persistCompletedFixture(item.hash, completionReport(evidenceId));

    await expectRejectsWithMessage(
      WorkItemStore.fail(item.hash),
      "Cannot fail a completed work item",
    );
  });

  test("rejects changing parentHash after creation", async () => {
    configureSqlite();
    const parent = await createItem("actual-parent");
    const item = await createItem("parent-immutable", { parentHash: parent.hash });

    await expectRejectsWithMessage(
      WorkItemStore.update(item.hash, {
        relations: { ...item.relations, parentHash: "wi_000000000002" },
      }),
      "Cannot change parentHash after creation",
    );
  });

  test("retries failed work items with a new basis and stable completion contract", async () => {
    configureSqlite();
    const item = await createItem("retry", {
      executorKind: "internal_chat_agent",
      workerRunId: "run:retry:1",
      workSessionId: "session:retry:1",
    });
    const failed = await WorkItemStore.fail(item.hash, "transient error");
    const retried = await WorkItemStore.retry(item.hash);

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
    const assigned = await WorkItemStore.assignExecution(item.hash, {
      executorKind: "internal_chat_agent",
      workerRunId: "run:retry:2",
      workSessionId: "session:retry:2",
    });
    expect(assigned).toMatchObject({
      executorKind: "internal_chat_agent",
      workerRunId: "run:retry:2",
      workSessionId: "session:retry:2",
    });
    await expect(
      WorkItemStore.assignExecution(item.hash, {
        executorKind: "internal_chat_agent",
        workerRunId: "run:retry:duplicate",
        workSessionId: "session:retry:duplicate",
      }),
    ).rejects.toThrow("already has an execution assignment");
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
    await WorkItemStore.fail(item.hash, "permanent error");

    await expectRejectsWithMessage(
      WorkItemStore.retry(item.hash),
      "retry attempts exhausted for work item",
    );

    const exhausted = WorkItemStore.get(item.hash);
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

    await WorkItemStore.fail(item.hash, "first failure");
    const secondAttempt = await WorkItemStore.retry(item.hash);
    await WorkItemStore.fail(item.hash, "second failure");
    const thirdAttempt = await WorkItemStore.retry(item.hash);
    await WorkItemStore.fail(item.hash, "third failure");

    await expectRejectsWithMessage(
      WorkItemStore.retry(item.hash),
      "retry attempts exhausted for work item",
    );

    const exhausted = WorkItemStore.get(item.hash);
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
    await WorkItemStore.fail(item.hash, "permanent error");

    await expectRejectsWithMessage(
      WorkItemStore.retry(item.hash),
      "retry attempts exhausted for work item",
    );
    await expectRejectsWithMessage(
      WorkItemStore.retry(item.hash),
      "retry attempts exhausted for work item",
    );

    const exhausted = WorkItemStore.get(item.hash);
    expect(exhausted?.blockers).toHaveLength(1);
  });

  test("keeps retry available for items without maxAttempts", async () => {
    configureSqlite();
    const item = await createItem("retry-without-max-attempts");

    await WorkItemStore.fail(item.hash, "first failure");
    const secondAttempt = await WorkItemStore.retry(item.hash);
    await WorkItemStore.fail(item.hash, "second failure");
    const thirdAttempt = await WorkItemStore.retry(item.hash);

    expect(secondAttempt?.attempt).toBe(2);
    expect(thirdAttempt?.attempt).toBe(3);
    expect(thirdAttempt ? WorkItem.deriveStatus(thirdAttempt) : undefined).toBe("running");
  });

  test("retry degrades gracefully when work item storage is missing", async () => {
    Storage.configure({
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

    await expect(WorkItemStore.retry("missing")).resolves.toBeUndefined();
  });

  test("degrades gracefully when work item storage is missing", async () => {
    const warnings: unknown[] = [];
    Bus.subscribe(Operational.Warn, (event) => warnings.push(event));
    Storage.configure({
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

    const item = await createItem("graceful");
    await flushBus();

    expect(item.hash).toStartWith("wi_");
    expect(WorkItem.deriveStatus(item)).toBe("pending");
    expect(warnings).toHaveLength(1);
    expect(WorkItemStore.get(item.hash)).toBeUndefined();
  });

  test("removes a work item", async () => {
    configureSqlite();
    const events: string[] = [];
    Bus.subscribe(WorkItem.Events.Removed, (event) => events.push(event.payload.hash));
    const item = await createItem("to-remove");
    expect(WorkItemStore.get(item.hash)).toBeDefined();
    expect(WorkItemStore.remove(item.hash)).toBe(true);
    await flushBus();
    expect(WorkItemStore.get(item.hash)).toBeUndefined();
    expect(WorkItemStore.remove(item.hash)).toBe(false);
    expect(events).toEqual([item.hash]);
  });

  test("rejects starting a failed item without retry", async () => {
    configureSqlite();
    const item = await createItem("start-failed");
    await WorkItemStore.fail(item.hash, "broken");
    await expectRejectsWithMessage(
      WorkItemStore.start(item.hash),
      "Cannot start a failed work item",
    );
  });

  test("rejects retrying a non-failed item", async () => {
    configureSqlite();
    const item = await createItem("retry-pending");
    await expectRejectsWithMessage(
      WorkItemStore.retry(item.hash),
      "retry() can only be called on failed work items",
    );
  });

  test("requires admission before inspecting unresolved report evidence", async () => {
    configureSqlite();
    const item = await createItem("missing-evidence");
    await WorkItemStore.start(item.hash);

    const code = await rawCompletionCode(item.hash, completionReport("ev_missing"));

    const stored = WorkItemStore.get(item.hash);
    expect(code).toBe("admission_required");
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("running");
    expect(stored?.completionReport).toBeUndefined();
  });

  test("requires admission before inspecting failed report evidence", async () => {
    configureSqlite();
    const item = await createItem("failed-evidence");
    await WorkItemStore.start(item.hash);
    const updated = await WorkItemStore.addReadBackEvidence(item.hash, {
      kind: "url_fetch",
      target: "https://example.com/post",
      passed: false,
      observedAt: 2,
      statusCode: 404,
    });
    const evidenceId = updated?.evidence.at(-1)?.id;
    if (!evidenceId) throw new Error("expected evidence id");

    const code = await rawCompletionCode(item.hash, completionReport(evidenceId));

    const stored = WorkItemStore.get(item.hash);
    expect(code).toBe("admission_required");
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("running");
    expect(stored?.completionReport).toBeUndefined();
  });

  test("rejects inconsistent read-back evidence", async () => {
    configureSqlite();
    const item = await createItem("inconsistent-read-back");

    await expectRejectsWithMessage(
      WorkItemStore.addEvidence(item.hash, {
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
      }),
      "readBack.passed must match evidence.passed",
    );
  });

  test("adds read-back verification evidence", async () => {
    configureSqlite();
    const item = await createItem("read-back");

    const updated = await WorkItemStore.addReadBackEvidence(item.hash, {
      kind: "citation_match",
      target: "https://example.com/source",
      passed: true,
      observedAt: 4,
      quotedText: "source sentence",
      matchedText: "source sentence",
    });

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

  test("returns unmet for missing work item in areDependenciesMet", () => {
    configureSqlite();
    expect(WorkItemStore.areDependenciesMet("wi_nonexistent0")).toEqual({
      met: false,
      reason: "pending",
    });
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
    Bus.subscribe(WorkItem.Events.Created, (event) => order.push(`event:${event.payload.hash}`));

    const item = await createItem("event-order");
    await flushBus();

    expect(order).toEqual([`write:${item.hash}`, `event:${item.hash}`]);
  });
});
