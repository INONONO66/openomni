import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import {
  Bus,
  BusPersistence,
  BusQuery,
  Session,
  SqliteStorageAdapter,
  Storage,
  WorkItemStore,
} from "../../src";

const flushBusPersistence = () => new Promise((resolve) => setTimeout(resolve, 10));

type WorkItemInput = Parameters<typeof WorkItemStore.create>[0];

function createInput(overrides: Partial<WorkItemInput> = {}): WorkItemInput {
  return {
    name: "Verify work item pipeline",
    sourceMessageId: "msg-work-item-1",
    sourceChannel: "test",
    intent: "verification",
    goal: "Verify WorkItem storage and observability plumbing",
    sessionId: "session-work-item-1",
    ...overrides,
  };
}

async function addEvidenceBackedReport(hash: string): Promise<WorkItem.CompletionReport> {
  const updated = await WorkItemStore.addEvidence(hash, {
    kind: "verification",
    description: "integration evidence recorded",
    passed: true,
  });
  const evidenceId = updated?.evidence.at(-1)?.id;
  if (!evidenceId) throw new Error("expected evidence id");
  return {
    summary: "Completed with integration evidence.",
    claims: [{ statement: "Integration path completed.", evidenceIds: [evidenceId] }],
    caveats: [],
    followUps: [],
  };
}

function resolveSessionId(_event: Bus.PublishedDescriptor, payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "sessionId" in payload) {
    return (payload as { sessionId?: string }).sessionId;
  }
  return undefined;
}

describe("WorkItem integration", () => {
  let adapter: SqliteStorageAdapter | undefined;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    adapter = new SqliteStorageAdapter(":memory:");
    Storage.configure(adapter);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    Bus.reset();
    Storage.reset();
    adapter?.close();
    adapter = undefined;
  });

  test("persists WorkItem bus events through BusPersistence", async () => {
    const sessionId = Session.create({
      title: "WorkItem pipeline",
      model: { providerID: "test", modelID: "test" },
    }).id;
    const emittedEvents: string[] = [];
    const unsubscribeCreated = Bus.subscribe(WorkItem.Events.Created, () => {
      emittedEvents.push(WorkItem.Events.Created.name);
    });
    const unsubscribeStatusChanged = Bus.subscribe(WorkItem.Events.StatusChanged, () => {
      emittedEvents.push(WorkItem.Events.StatusChanged.name);
    });
    const unsubscribeCompleted = Bus.subscribe(WorkItem.Events.Completed, () => {
      emittedEvents.push(WorkItem.Events.Completed.name);
    });

    stop = BusPersistence.start({ resolveSessionId });

    const item = await WorkItemStore.create(createInput({ sessionId }));
    const completed = await WorkItemStore.complete(
      item.hash,
      await addEvidenceBackedReport(item.hash),
    );

    await flushBusPersistence();
    unsubscribeCreated();
    unsubscribeStatusChanged();
    unsubscribeCompleted();

    expect(completed).toBeDefined();
    expect(emittedEvents).toContain(WorkItem.Events.Created.name);
    expect(emittedEvents).toContain(WorkItem.Events.StatusChanged.name);
    expect(emittedEvents).toContain(WorkItem.Events.Completed.name);

    const events = await BusQuery.listBySession(sessionId, { limit: 100 });
    const eventTypes = events.map((event) => event.eventType);

    expect(eventTypes).toContain(WorkItem.Events.Created.name);
    expect(eventTypes).toContain(WorkItem.Events.StatusChanged.name);
    expect(eventTypes).toContain(WorkItem.Events.Completed.name);
    expect(events.every((event) => event.category === "work_item")).toBe(true);
    expect(events.every((event) => event.sessionId === sessionId)).toBe(true);
  });

  test("tracks parent, child, and dependency readiness", async () => {
    const parent = await WorkItemStore.create(
      createInput({ name: "Parent", sourceMessageId: "msg-parent" }),
    );
    const child1 = await WorkItemStore.create(
      createInput({
        name: "Child one",
        sourceMessageId: "msg-child-1",
        parentHash: parent.hash,
      }),
    );
    const child2 = await WorkItemStore.create(
      createInput({
        name: "Child two",
        sourceMessageId: "msg-child-2",
        parentHash: parent.hash,
        dependsOn: [child1.hash],
      }),
    );

    const storedParent = WorkItemStore.get(parent.hash);

    expect(storedParent?.relations.childHashes).toContain(child1.hash);
    expect(storedParent?.relations.childHashes).toContain(child2.hash);
    expect(WorkItemStore.areDependenciesMet(child2.hash)).toEqual({
      met: false,
      reason: "pending",
    });

    await WorkItemStore.complete(child1.hash, await addEvidenceBackedReport(child1.hash));

    expect(WorkItemStore.areDependenciesMet(child2.hash)).toEqual({
      met: true,
      reason: "all_complete",
    });
  });

  test("round-trips WorkItemStore data through SqliteStorageAdapter", async () => {
    const item = await WorkItemStore.create(
      createInput({
        name: "Round-trip item",
        sourceMessageId: "msg-round-trip",
        sessionId: "session-work-item-round-trip",
      }),
    );

    const stored = adapter?.workItem?.get(item.hash);

    expect(stored).toEqual(item);
    expect(stored?.hash).toBe(item.hash);
    expect(WorkItem.deriveStatus(stored as WorkItem.Info)).toBe("pending");
  });
});
