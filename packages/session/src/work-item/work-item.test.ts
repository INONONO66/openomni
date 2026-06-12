import { afterEach, describe, expect, test } from "bun:test";
import { Operational, WorkItem } from "@openomni/protocol";
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
};

const adapters: SqliteStorageAdapter[] = [];

function configureSqlite(): SqliteStorageAdapter {
  const adapter = new SqliteStorageAdapter(":memory:");
  adapters.push(adapter);
  Storage.configure(adapter);
  return adapter;
}

async function flushBus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

afterEach(() => {
  Bus.reset();
  Storage.reset();
  for (const adapter of adapters.splice(0)) {
    adapter.close();
  }
});

describe("WorkItemStore", () => {
  test("runs the full lifecycle and publishes lifecycle events", async () => {
    configureSqlite();
    const events: string[] = [];
    Bus.subscribe(WorkItem.Events.Created, () => events.push("created"));
    Bus.subscribe(WorkItem.Events.StatusChanged, (event) =>
      events.push(`status:${event.payload.from}->${event.payload.to}`),
    );
    Bus.subscribe(WorkItem.Events.Completed, () => events.push("completed"));

    const item = await createItem("lifecycle");
    const started = await WorkItemStore.start(item.hash);
    const evidenceId = await addPassingEvidence(item.hash);
    const withEvidence = WorkItemStore.get(item.hash);
    const completed = await WorkItemStore.complete(item.hash, completionReport(evidenceId));
    await flushBus();

    expect(started).toBeDefined();
    expect(withEvidence?.evidence).toHaveLength(1);
    expect(completed).toBeDefined();
    expect(completed ? WorkItem.deriveStatus(completed) : undefined).toBe("completed");
    expect(events).toEqual([
      "created",
      "status:pending->running",
      "status:running->completed",
      "completed",
    ]);
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
    await WorkItemStore.complete(dependency.hash, completionReport(evidenceId));

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

  test("rejects completing a failed item", async () => {
    configureSqlite();
    const item = await createItem("fail-then-complete");
    const evidenceId = await addPassingEvidence(item.hash);

    await WorkItemStore.fail(item.hash, "broken");

    await expectRejectsWithMessage(
      WorkItemStore.complete(item.hash, completionReport(evidenceId)),
      "Cannot complete a failed work item",
    );
  });

  test("rejects failing a completed item", async () => {
    configureSqlite();
    const item = await createItem("complete-then-fail");

    const evidenceId = await addPassingEvidence(item.hash);
    await WorkItemStore.complete(item.hash, completionReport(evidenceId));

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

  test("retries failed work items with a new attempt and running status", async () => {
    configureSqlite();
    const item = await createItem("retry");
    const failed = await WorkItemStore.fail(item.hash, "transient error");
    const retried = await WorkItemStore.retry(item.hash);

    expect(failed?.attempt).toBe(1);
    expect(retried?.attempt).toBe(2);
    expect(retried?.failureReason).toBeUndefined();
    expect(retried?.timestamps.failed).toBeUndefined();
    expect(retried?.timestamps.started).toBeNumber();
    expect(retried ? WorkItem.deriveStatus(retried) : undefined).toBe("running");
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

  test("rejects completion reports without resolvable evidence", async () => {
    configureSqlite();
    const item = await createItem("missing-evidence");
    await WorkItemStore.start(item.hash);

    await expectRejectsWithMessage(
      WorkItemStore.complete(item.hash, completionReport("ev_missing")),
      "completion report references missing evidence",
    );

    const stored = WorkItemStore.get(item.hash);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("running");
    expect(stored?.completionReport).toBeUndefined();
  });

  test("rejects completion reports that cite failed evidence", async () => {
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

    await expectRejectsWithMessage(
      WorkItemStore.complete(item.hash, completionReport(evidenceId)),
      "completion report references failed evidence",
    );

    const stored = WorkItemStore.get(item.hash);
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
    const originalSet = adapter.workItem.set.bind(adapter.workItem);
    adapter.workItem.set = (hash, item) => {
      originalSet(hash, item);
      order.push(`write:${hash}`);
    };
    Bus.subscribe(WorkItem.Events.Created, (event) => order.push(`event:${event.payload.hash}`));

    const item = await createItem("event-order");
    await flushBus();

    expect(order).toEqual([`write:${item.hash}`, `event:${item.hash}`]);
  });
});
