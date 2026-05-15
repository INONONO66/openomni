import { mkdir, appendFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { Operational, WorkItem } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { SqliteStorageAdapter } from "../storage/sqlite-storage.js";
import { Storage } from "../storage/storage.js";
import { WorkItemStore } from "./index.js";

const evidenceDir = ".sisyphus/evidence";

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

async function saveEvidence(fileName: string, content: string): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await appendFile(`${evidenceDir}/${fileName}`, `${new Date().toISOString()} ${content}\n`);
}

async function createItem(
  name: string,
  extra?: Partial<Parameters<typeof WorkItemStore.create>[0]>,
) {
  return WorkItemStore.create({ ...baseInput, ...extra, name });
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
    const withEvidence = await WorkItemStore.addEvidence(item.hash, {
      kind: "test_result",
      description: "targeted lifecycle test passed",
      passed: true,
      detail: "bun test packages/session/src/work-item/",
    });
    const completed = await WorkItemStore.complete(item.hash);
    await flushBus();

    expect(started).toBeDefined();
    expect(withEvidence?.evidence).toHaveLength(1);
    expect(completed).toBeDefined();
    expect(WorkItem.deriveStatus(completed!)).toBe("completed");
    expect(events).toEqual([
      "created",
      "status:pending->running",
      "status:running->completed",
      "completed",
    ]);
    await saveEvidence("task-3-lifecycle.txt", `hash=${item.hash} events=${events.join(",")}`);
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

    expect(WorkItem.deriveStatus(blocked!)).toBe("blocked");
    expect(WorkItem.deriveStatus(resumed!)).toBe("running");
    expect(statuses).toEqual(["pending->running", "running->blocked", "blocked->running"]);
    await saveEvidence(
      "task-3-blocker-flow.txt",
      `hash=${item.hash} statuses=${statuses.join(",")}`,
    );
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
    await WorkItemStore.complete(dependency.hash);

    expect(WorkItemStore.areDependenciesMet(dependent.hash)).toEqual({
      met: true,
      reason: "all_complete",
    });
    await saveEvidence(
      "task-3-dependency-chain.txt",
      `dependency=${dependency.hash} dependent=${dependent.hash} ready=all_complete`,
    );
  });

  test("rejects circular dependency updates", async () => {
    configureSqlite();
    const first = await createItem("cycle-a");
    const second = await createItem("cycle-b", { dependsOn: [first.hash] });

    expect(() =>
      WorkItemStore.update(first.hash, {
        relations: { ...first.relations, dependsOn: [second.hash] },
      }),
    ).toThrow("Circular dependency detected");
    await saveEvidence(
      "task-3-cycle-detection.txt",
      `first=${first.hash} second=${second.hash} rejected=true`,
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
    expect(WorkItem.deriveStatus(retried!)).toBe("running");
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
    const item = await createItem("to-remove");
    expect(WorkItemStore.get(item.hash)).toBeDefined();
    expect(WorkItemStore.remove(item.hash)).toBe(true);
    expect(WorkItemStore.get(item.hash)).toBeUndefined();
    expect(WorkItemStore.remove(item.hash)).toBe(false);
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
