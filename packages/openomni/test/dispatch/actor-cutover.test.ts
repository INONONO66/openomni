import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Session, Storage, WorkerRunStateStore, WorkItemStore } from "@openomni/session";
import { deriveActorContext } from "../../src/dispatch/actor";

/**
 * #510 D2b pin (d) — trustTier derivation cut over from the worker-run
 * store to WorkItem attempt facts:
 *
 *   - a NEW run (attempt facts, no worker_run_state row) derives
 *     kind "worker" / trustTier "assigned_worker";
 *   - a LEGACY run (frozen worker_run_state row, no WorkItem) keeps deriving
 *     the same through the upcast read.
 */

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

function attemptIdentity(prompt: string) {
  return {
    contentFingerprint: WorkItem.contentFingerprintOf({
      workInput: prompt,
      handlerKind: "internal_chat_agent",
      handlerCodeRef: { absent: true, reason: "not captured in this test" },
      model: {
        provider: "test",
        id: "test-model",
        parameters: { absent: true, reason: "no parameters configured" },
      },
      upstreamFingerprints: { absent: true, reason: "no upstream attempts" },
      dependencyLock: { absent: true, reason: "not read in this test" },
    }),
    environmentFingerprint: WorkItem.environmentFingerprintOf({
      os: process.platform,
      arch: process.arch,
      bunVersion: process.versions.bun ?? process.version,
      workspaceRoot: { absent: true, reason: "no workspace in this test" },
      schemaVersions: { policyKernel: 1 },
      policy: { absent: true, reason: "no policy plan in this test" },
      toolVersions: { absent: true, reason: "not enumerated in this test" },
      verifierVersions: { absent: true, reason: "not enumerated in this test" },
      providerParameters: { absent: true, reason: "no provider parameters" },
      configRef: { absent: true, reason: "no config identity in this test" },
    }),
  };
}

describe("dispatch actor trustTier (#510 D2b)", () => {
  test("pin (d): a new run with attempt facts and no worker_run row derives assigned_worker", async () => {
    const session = Session.create({
      title: "actor-cutover-new",
      model: { providerID: "test", modelID: "test-model" },
    });
    const runId = "run-attempt-facts";
    const item = await WorkItemStore.create(
      {
        name: "attempt-run",
        sourceMessageId: "event-actor-cutover",
        sourceChannel: "ingress",
        intent: "worker.dispatch",
        goal: "derive trust from attempt facts",
        sessionId: session.id,
        workSessionId: session.id,
        workerRunId: runId,
        executorKind: "internal_chat_agent",
        acceptanceCriteria: ["the dispatched worker run reaches a terminal attempt outcome"],
      },
      "trace-test",
    );
    await WorkItemStore.start(item.hash, "trace-test");
    const allocation = await WorkItemStore.allocateAttempt(
      item.hash,
      attemptIdentity("derive trust from attempt facts"),
      "trace-test",
    );
    if (!allocation) throw new Error("attempt allocation failed");

    // No worker_run_state row exists for this run.
    expect(WorkerRunStateStore.get(session.id, runId)).toBeUndefined();

    const actor = deriveActorContext({ sessionId: session.id, runId });
    expect(actor.kind).toBe("worker");
    expect(actor.trustTier).toBe("assigned_worker");
    expect(actor.workerRunId).toBe(runId);
  });

  test("pin (d): a legacy frozen worker_run row still derives assigned_worker via upcast", () => {
    const session = Session.create({
      title: "actor-cutover-legacy",
      model: { providerID: "test", modelID: "test-model" },
    });
    const adapter = Storage.getAdapter().workerRunState;
    if (!adapter) throw new Error("workerRunState sub-adapter missing");
    // Legacy rows are seeded at the adapter layer, exactly as pre-freeze
    // rows persist on disk (pending-interaction precedent).
    adapter.create(session.id, {
      runId: "run-legacy-actor",
      agentName: "worker",
      status: "succeeded",
      executorKind: "internal_chat_agent",
      title: "legacy",
      prompt: "legacy",
    });

    const actor = deriveActorContext({ sessionId: session.id, runId: "run-legacy-actor" });
    expect(actor.kind).toBe("worker");
    expect(actor.trustTier).toBe("assigned_worker");
    expect(actor.workerRunId).toBe("run-legacy-actor");
  });
});
