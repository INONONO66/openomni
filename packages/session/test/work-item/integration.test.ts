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

type WorkItemInput = Parameters<typeof WorkItemStore.create>[0];

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

function persistCompletedFixture(
  hash: string,
  report: WorkItem.CompletionReport,
  options: Readonly<{ publishTerminalEvents: boolean }>,
): WorkItem.Info | undefined {
  const workItemAdapter = Storage.get().workItem;
  const current = workItemAdapter?.get(hash);
  if (!workItemAdapter || !current) return undefined;
  const admission = WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${hash}:${current.revision + 1}:integration-fixture`,
    requestId: `completion-request:${hash}:${current.revision}:integration-fixture`,
    requestSnapshot: WorkItem.CompletionRequest.parse({
      version: 1,
      id: `completion-request:${hash}:${current.revision}:integration-fixture`,
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
    reasonCodes: ["session_integration_fixture"],
    residualRisks: [],
    policyRef: "policy:session-integration-fixture",
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
  if (!workItemAdapter.compareAndSet(hash, current.revision, admitted)) return undefined;
  const completedAt = admission.createdAt + 1;
  const receipt: WorkItem.CompletionTerminalReceipt = {
    version: 1,
    hash,
    requestId: admission.requestId,
    admissionId: admission.id,
    contractRevision: admission.contractRevision,
    basisRef: admission.basisRef,
    recordedHead: admitted.revision + 1,
  };
  const completed = WorkItem.Info.parse({
    ...admitted,
    revision: admitted.revision + 1,
    completionReport: report,
    completionTerminalReceipt: receipt,
    timestamps: { ...admitted.timestamps, completed: completedAt, updated: completedAt },
  });
  if (!workItemAdapter.compareAndSet(hash, admitted.revision, completed)) return undefined;
  if (options.publishTerminalEvents) {
    Bus.publish(WorkItem.Events.StatusChanged, {
      traceId: "trace-session-integration-fixture",
      time: completedAt,
      sessionId: completed.sessionId,
      payload: { hash, from: WorkItem.deriveStatus(admitted), to: "completed" },
    });
    Bus.publish(WorkItem.Events.Updated, {
      traceId: "trace-session-integration-fixture",
      time: completedAt,
      sessionId: completed.sessionId,
      payload: { hash, fields: ["completionTerminalReceipt"] },
    });
    Bus.publish(WorkItem.Events.CompletedV2, {
      traceId: "trace-session-integration-fixture",
      time: completedAt,
      sessionId: completed.sessionId,
      payload: { ...receipt, sessionId: completed.sessionId },
    });
  }
  return completed;
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
    const unsubscribeCompleted = Bus.subscribe(WorkItem.Events.CompletedV2, () => {
      emittedEvents.push(WorkItem.Events.CompletedV2.name);
    });

    stop = BusPersistence.start({ resolveSessionId });

    const item = await WorkItemStore.create(createInput({ sessionId }));
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

    const events = await BusQuery.listBySession(sessionId, { limit: 100 });
    const eventTypes = events.map((event) => event.eventType);

    expect(eventTypes).toContain(WorkItem.Events.Created.name);
    expect(eventTypes).toContain(WorkItem.Events.StatusChanged.name);
    expect(eventTypes).toContain(WorkItem.Events.CompletedV2.name);
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

    persistCompletedFixture(child1.hash, await addEvidenceBackedReport(child1.hash), {
      publishTerminalEvents: false,
    });

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
