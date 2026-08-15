import { expect } from "bun:test";
import { WorkItem, type Dispatch } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/session";

export function command(
  action: string,
  target: Dispatch.Target,
  payload: unknown = "hello",
): Dispatch.Command {
  return {
    dispatchId: `dispatch-${action}`,
    action,
    target,
    payload,
    actor: { kind: "resident", actorId: "agent:resident", agentName: "resident" },
    traceId: "trace-1",
    submittedAt: Date.now(),
  };
}

export function workerSpawnPayload(text: string): {
  readonly text: string;
  readonly acceptanceCriteria: readonly string[];
} {
  return {
    text,
    acceptanceCriteria: ["The delegated worker returns evidence-backed completion"],
  };
}

export function createSessionFixture(id: string): void {
  const now = Date.now();
  Storage.getAdapter().session.set(id, {
    id,
    title: id,
    model: { providerID: "test", modelID: "test" },
    time: { created: now, updated: now },
    spawnDepth: 0,
  });
}

/**
 * #510 D2b — the run's execution instance is the WorkItem attempt: fixtures
 * that previously seeded a live worker_run_state row allocate an attempt on
 * the work item instead (the worker-run store is frozen).
 */
export async function allocateTestAttempt(workItemHash: string): Promise<string> {
  const item = WorkItemStore.get(workItemHash);
  if (!item) throw new Error(`missing WorkItem for attempt fixture: ${workItemHash}`);
  if (item.currentAttemptId) return item.currentAttemptId;
  const allocation = await WorkItemStore.allocateAttempt(
    workItemHash,
    {
      contentFingerprint: WorkItem.contentFingerprintOf({
        workInput: item.goal || "test work input",
        handlerKind: item.executorKind ?? "internal_chat_agent",
        handlerCodeRef: { absent: true, reason: "not captured in tests" },
        model: {
          provider: "test",
          id: "test-model",
          parameters: { absent: true, reason: "no parameters configured" },
        },
        upstreamFingerprints: { absent: true, reason: "no upstream attempts" },
        dependencyLock: { absent: true, reason: "not read in tests" },
      }),
      environmentFingerprint: WorkItem.environmentFingerprintOf({
        os: process.platform,
        arch: process.arch,
        bunVersion: process.versions.bun ?? process.version,
        workspaceRoot: { absent: true, reason: "no workspace in tests" },
        schemaVersions: { policyKernel: 1 },
        policy: { absent: true, reason: "no policy plan in tests" },
        toolVersions: { absent: true, reason: "not enumerated in tests" },
        verifierVersions: { absent: true, reason: "not enumerated in tests" },
        providerParameters: { absent: true, reason: "no provider parameters" },
        configRef: { absent: true, reason: "no config identity in tests" },
      }),
    },
    "trace-test",
  );
  if (!allocation) throw new Error(`attempt allocation failed: ${workItemHash}`);
  return allocation.attempt.attemptId;
}

export async function expectRejectsWithMessage(
  operation: () => unknown,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) return;
    expect(err.message).toContain(message);
    return;
  }
  throw new Error(`Expected operation to reject with ${message}`);
}
