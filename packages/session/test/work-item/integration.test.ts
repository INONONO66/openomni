import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { BusPersistence, Session, SqliteStorageAdapter, Storage, WorkItemStore } from "../../src";
import { Bus } from "@openomni/telemetry";
import { getDatabase } from "../../src/bus-persistence/database.js";
import { persistCompletedWorkItemFixture } from "./completed-fixture.js";

type WorkItemInput = Parameters<typeof WorkItemStore.create>[0];
let completionWriter: Storage.WorkItemCompletionWriter;

function createInput(overrides: Partial<WorkItemInput> = {}): WorkItemInput {
  return {
    name: "Verify work item pipeline",
    sourceMessageId: "msg-work-item-1",
    sourceChannel: "test",
    intent: "verification",
    goal: "Verify WorkItem storage and observability plumbing",
    sessionId: "session-work-item-1",
    acceptanceCriteria: ["the WorkItem pipeline is verified"],
    ...overrides,
  };
}

async function addEvidenceBackedReport(hash: string): Promise<WorkItem.CompletionReport> {
  const updated = await WorkItemStore.addEvidence(
    hash,
    {
      kind: "verification",
      description: "integration evidence recorded",
      passed: true,
    },
    "trace-test",
  );
  const evidenceId = updated?.evidence.at(-1)?.id;
  if (!evidenceId) throw new Error("expected evidence id");
  return {
    summary: "Completed with integration evidence.",
    claims: [{ statement: "the WorkItem pipeline is verified", evidenceIds: [evidenceId] }],
    caveats: [],
    followUps: [],
  };
}

function persistCompletedFixture(
  hash: string,
  report: WorkItem.CompletionReport,
  options: Readonly<{ publishTerminalEvents: boolean }>,
): WorkItem.Info | undefined {
  return persistCompletedWorkItemFixture({
    hash,
    report,
    completionWriter,
    publishTerminalEvents: options.publishTerminalEvents,
  });
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
    completionWriter = Storage.configure(adapter);
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
      traceId: "trace-work-item",
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
    const unsubscribeCompleted = Bus.subscribe(WorkItem.Events.CompletedV2, () => {
      emittedEvents.push(WorkItem.Events.CompletedV2.name);
    });

    stop = BusPersistence.start({ resolveSessionId });

    const item = await WorkItemStore.create(createInput({ sessionId }), "trace-test");
    const completed = persistCompletedFixture(item.hash, await addEvidenceBackedReport(item.hash), {
      publishTerminalEvents: true,
    });

    await BusPersistence.flush();
    unsubscribeCreated();
    unsubscribeStatusChanged();
    unsubscribeCompleted();

    expect(completed).toBeDefined();
    expect(emittedEvents).toContain(WorkItem.Events.Created.name);
    expect(emittedEvents).toContain(WorkItem.Events.StatusChanged.name);
    expect(emittedEvents).toContain(WorkItem.Events.CompletedV2.name);

    const events = getDatabase()
      .query<{ event_type: string; category: string }, [string]>(
        "SELECT event_type, category FROM bus_event WHERE session_id = ?",
      )
      .all(sessionId);
    const eventTypes = events.map((event) => event.event_type);

    expect(eventTypes).toContain(WorkItem.Events.Created.name);
    expect(eventTypes).toContain(WorkItem.Events.StatusChanged.name);
    expect(eventTypes).toContain(WorkItem.Events.CompletedV2.name);
    expect(events.every((event) => event.category === "work_item")).toBe(true);
  });

  test("tracks parent, child, and dependency readiness", async () => {
    const parent = await WorkItemStore.create(
      createInput({ name: "Parent", sourceMessageId: "msg-parent" }),
      "trace-test",
    );
    const child1 = await WorkItemStore.create(
      createInput({
        name: "Child one",
        sourceMessageId: "msg-child-1",
        parentHash: parent.hash,
      }),
      "trace-test",
    );
    const child2 = await WorkItemStore.create(
      createInput({
        name: "Child two",
        sourceMessageId: "msg-child-2",
        parentHash: parent.hash,
        dependsOn: [child1.hash],
      }),
      "trace-test",
    );

    const storedParent = WorkItemStore.get(parent.hash);

    expect(storedParent?.relations.childHashes).toContain(child1.hash);
    expect(storedParent?.relations.childHashes).toContain(child2.hash);
    // #606: areDependenciesMet was removed (no consumer); the dependency
    // GRAPH round-trip is the pin — readiness derivation belongs to a future
    // scheduler.
    expect(WorkItemStore.get(child2.hash)?.relations.dependsOn).toEqual([child1.hash]);
    const dependency = WorkItemStore.get(child1.hash);
    expect(dependency ? WorkItem.deriveStatus(dependency) : undefined).toBe("pending");

    persistCompletedFixture(child1.hash, await addEvidenceBackedReport(child1.hash), {
      publishTerminalEvents: false,
    });

    const completedDependency = WorkItemStore.get(child1.hash);
    expect(completedDependency ? WorkItem.deriveStatus(completedDependency) : undefined).toBe(
      "completed",
    );
  });

  test("round-trips WorkItemStore data through SqliteStorageAdapter", async () => {
    const item = await WorkItemStore.create(
      createInput({
        name: "Round-trip item",
        sourceMessageId: "msg-round-trip",
        sessionId: "session-work-item-round-trip",
      }),
      "trace-test",
    );

    const stored = adapter?.workItem?.get(item.hash);

    expect(stored).toEqual(item);
    expect(stored?.hash).toBe(item.hash);
    expect(WorkItem.deriveStatus(stored as WorkItem.Info)).toBe("pending");
  });
});
