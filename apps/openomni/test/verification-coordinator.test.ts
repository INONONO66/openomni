// allow: SIZE_OK — coordinator crash-recovery scenarios share one real SQLite fixture.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DelegationStore, SqliteStorageAdapter, Storage, WorkItemStore } from "@openomni/ledger";
import { Delegation, WorkItem } from "@openomni/protocol";
import type { Admitted } from "../src/delegation/admission";
import { createDelegationKernel } from "../src/delegation/kernel";
import {
  type CommandVerifierPort,
  createVerificationCoordinator,
} from "../src/delegation/verification";
import { createWorkItemLinkage } from "../src/delegation/work-item-linkage";

const adapters: SqliteStorageAdapter[] = [];
const SHA = "a".repeat(64);
const NOW = 10_000;

function linkage() {
  return createWorkItemLinkage({ model: { provider: "test", id: "test" }, now: () => NOW });
}

async function fixture(delegationId: string, verifier?: CommandVerifierPort) {
  const adapter = new SqliteStorageAdapter(":memory:");
  adapters.push(adapter);
  Storage.configure(adapter);
  const workItems = linkage();
  const workItemId = await workItems.openAssign({
    delegationId,
    workerRunId: delegationId,
    transport: "process",
    instruction: "run the build",
    acceptanceCriteria: ["build passes"],
    sessionId: "session-807",
  });
  const request = Delegation.Request.parse({
    operation: "assign",
    address: { kind: "core", scope: "independent" },
    payload: { text: "run the build" },
    acceptanceCriteria: ["build passes"],
    verification: {
      kind: "command.v1",
      executable: { id: "bun" },
      argv: ["run", "build"],
      timeoutMs: 1_000,
      expectations: [{ criterionIndex: 0, exitCode: 0, stdoutSha256: SHA }],
    },
    deadline: 20_000,
  });
  const record = Delegation.Record.parse({
    delegationId,
    operation: "assign",
    address: request.address,
    transport: "process",
    deadline: request.deadline,
    workItemId,
    rootDelegationId: delegationId,
    origin: { role: "resident", depth: 0, sessionId: "session-807" },
    instruction: request.payload.text,
    status: "open",
    createdAt: 1_000,
  });
  DelegationStore.create(record);
  const admitted: Admitted = {
    ok: true,
    delegationId,
    request,
    transport: "process",
    effectiveDeadline: request.deadline,
    rootDelegationId: delegationId,
    childOrigin: {
      role: "worker",
      depth: 0,
      sessionId: "session-807",
      parentDelegationId: delegationId,
      rootDelegationId: delegationId,
    },
  };
  return {
    adapter,
    workItems,
    workItemId,
    record,
    admitted,
    coordinator: createVerificationCoordinator({
      ...(verifier === undefined ? {} : { verifier }),
      now: () => NOW,
    }),
  };
}

const completed = {
  status: "completed" as const,
  output: "worker says done",
  workerRunId: "run-1",
};
const passingVerifier: CommandVerifierPort = {
  run: () =>
    Promise.resolve({
      status: "exited",
      exitCode: 0,
      stdoutSha256: SHA,
      stderrSha256: "b".repeat(64),
      stdoutBytes: 12,
      stderrBytes: 0,
      truncated: false,
      durationMs: 20,
    }),
};

afterEach(() => {
  Storage.reset();
  for (const adapter of adapters.splice(0)) adapter.close();
});

describe("verification coordinator", () => {
  test("an assign self-report is unverified when no check was declared", async () => {
    const scope = await fixture("d-not-declared", passingVerifier);
    const admitted = {
      ...scope.admitted,
      request: Delegation.Request.parse({
        ...scope.admitted.request,
        verification: undefined,
      }),
    };

    const settlement = await scope.coordinator.settleAssign({
      admitted,
      record: scope.record,
      outcome: completed,
      at: NOW,
    });

    expect(settlement).toMatchObject({
      status: "unverified",
      reason: "not_declared",
      factIds: [],
      output: completed.output,
    });
    expect(WorkItemStore.get(scope.workItemId)?.completionFacts.results).toEqual([]);
  });

  test("a declared assign is unverified when the verifier port is absent", async () => {
    const scope = await fixture("d-no-verifier");

    const settlement = await scope.coordinator.settleAssign({
      admitted: scope.admitted,
      record: scope.record,
      outcome: completed,
      at: NOW,
    });

    expect(settlement).toMatchObject({
      status: "unverified",
      reason: "verifier_unavailable",
      factIds: [],
    });
  });

  test("a timed-out declared predicate persists an inconclusive unverified proof", async () => {
    // Given: a declared command predicate whose isolated run reaches its timeout.
    const scope = await fixture("d-timeout", {
      run: () => Promise.resolve({ status: "timed_out", durationMs: 1_000 }),
    });
    const item = WorkItemStore.get(scope.workItemId);
    const criterion = item?.completionFacts.criteria[0];
    if (item === undefined || criterion === undefined) throw new Error("fixture criterion missing");

    // When: verification settles the assign.
    const settlement = await scope.coordinator.settleAssign({
      admitted: scope.admitted,
      record: scope.record,
      outcome: completed,
      at: NOW,
    });

    // Then: the durable result is inconclusive and the settlement names exactly that proof.
    const recorded = WorkItemStore.get(scope.workItemId);
    const attemptRef = `attempt:${item.currentAttemptId}`;
    const resultId = `result:verifier:${scope.record.delegationId}:${attemptRef}:${criterion.id}`;
    const observationId = `observation:verifier:${scope.record.delegationId}:${attemptRef}:${criterion.id}`;
    const evidenceId = `evidence:verifier:${scope.record.delegationId}:${attemptRef}:${criterion.id}`;
    const argvHash = createHash("sha256")
      .update(JSON.stringify(["run", "build"]))
      .digest("hex");
    expect(settlement).toEqual({
      delegationId: scope.record.delegationId,
      status: "unverified",
      reason: "verification_failed",
      output: completed.output,
      workerRunId: completed.workerRunId,
      basisRef: item.completionContract.basisRef,
      factIds: [resultId],
      at: NOW,
    });
    expect(recorded?.completionFacts.results).toEqual([
      {
        id: resultId,
        criterionId: criterion.id,
        value: "inconclusive",
        checkedPredicate: `command.v1:bun:${argvHash}:exit=0:stdout=${SHA}`,
        observationIds: [observationId],
        verifierRef: `verifier:command.v1:${scope.record.delegationId}:${attemptRef}`,
        assumptions: [],
        basisRef: item.completionContract.basisRef,
        residualRisks: [],
        createdAt: NOW,
      },
    ]);
    expect(recorded?.completionFacts.verificationErrors).toEqual([]);
    expect(recorded?.completionFacts.observations).toEqual([
      {
        id: observationId,
        producer: "verifier:command.v1",
        subjectRef: scope.workItemId,
        basisRef: item.completionContract.basisRef,
        artifactRefs: [evidenceId],
        provenanceRef: evidenceId,
        ancestryRefs: [attemptRef],
        observedAt: NOW,
      },
    ]);
    expect(recorded?.evidence).toEqual([
      expect.objectContaining({
        id: `evidence:delegation:${scope.record.delegationId}:${attemptRef}:worker-report`,
        passed: false,
        attempt: item.lastAttemptSeq,
        basisRef: item.completionContract.basisRef,
      }),
      expect.objectContaining({
        id: evidenceId,
        passed: false,
        detail: JSON.stringify({ status: "timed_out", durationMs: 1_000 }),
        attempt: item.lastAttemptSeq,
        basisRef: item.completionContract.basisRef,
      }),
    ]);
  });

  test("boot recovery cancels an orphan commission and preserves an open delegation", async () => {
    // Given: commissioning committed before its delegation record, alongside a valid open pair.
    const scope = await fixture("d-existing", passingVerifier);
    const orphanWorkItemId = await scope.workItems.openAssign({
      delegationId: "d-orphan",
      workerRunId: "d-orphan",
      transport: "process",
      instruction: "orphaned commission",
      acceptanceCriteria: ["never admitted"],
      sessionId: "session-orphan",
    });
    const openWorkItemId = await scope.workItems.openAssign({
      delegationId: "d-channel-open",
      workerRunId: "wait-channel-open",
      transport: "channel",
      instruction: "wait for an external actor",
      acceptanceCriteria: ["actor responds"],
      sessionId: "session-open",
    });
    DelegationStore.create({
      delegationId: "d-channel-open",
      operation: "assign",
      address: { kind: "actor", actorId: "actor-open" },
      transport: "channel",
      deadline: 20_000,
      workItemId: openWorkItemId,
      rootDelegationId: "d-channel-open",
      origin: { role: "resident", depth: 0, sessionId: "session-open" },
      instruction: "wait for an external actor",
      status: "open",
      createdAt: 1_000,
    });
    let recoveryFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      recoveryFinished = resolve;
    });
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => NOW,
      newDelegationId: () => "unused",
      wake: () => undefined,
      workItems: {
        ...scope.workItems,
        recoverAttempts: async (lookup) => {
          await scope.workItems.recoverAttempts(lookup);
          recoveryFinished?.();
        },
      },
      verification: scope.coordinator,
    });

    // When: the boot sweep completes and is repeated.
    await finished;
    const cancelled = WorkItemStore.get(orphanWorkItemId);
    const open = WorkItemStore.get(openWorkItemId);
    const cancelledRevision = cancelled?.revision;
    kernel.stop();
    await scope.workItems.recoverAttempts((delegationId) => DelegationStore.get(delegationId));

    // Then: only the orphan is cancelled, and its cancellation is exactly once.
    expect(cancelled?.timestamps.cancelled).toEqual(expect.any(Number));
    expect(cancelled?.attemptTerminal).toBeUndefined();
    expect(WorkItemStore.get(orphanWorkItemId)?.revision).toBe(cancelledRevision);
    expect(open?.timestamps.cancelled).toBeUndefined();
    expect(open?.attemptTerminal).toBeUndefined();
    expect(DelegationStore.get("d-channel-open")?.status).toBe("open");
    expect(
      scope.adapter.ledger
        .factsByType("work_item.cancelled")
        .filter((fact) => fact.streamId === `work:${orphanWorkItemId}`),
    ).toHaveLength(1);
  });

  test("recovers the fact-to-terminal-CAS crash with the same fact ids exactly once", async () => {
    const scope = await fixture("d-fact-cas", passingVerifier);

    const candidate = await scope.coordinator.settleAssign({
      admitted: scope.admitted,
      record: scope.record,
      outcome: completed,
      at: NOW,
    });
    const factBeforeTerminal = scope.adapter.ledger.headFact(`work:${scope.workItemId}`)?.type;
    const openBeforeRestart = DelegationStore.get(scope.record.delegationId)?.status;
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => NOW + 1,
      newDelegationId: () => "unused",
      wake: () => undefined,
      workItems: scope.workItems,
      verification: scope.coordinator,
    });

    const recovered = DelegationStore.get(scope.record.delegationId)?.settled;
    kernel.stop();
    if (candidate.status !== "verified") throw new Error("fixture verification did not pass");
    expect(factBeforeTerminal).toBe("work_item.verification_recorded");
    expect(openBeforeRestart).toBe("open");
    expect(recovered).toMatchObject({ status: "verified", factIds: candidate.factIds });
    expect(
      scope.adapter.ledger
        .factsByType("work_item.verification_recorded")
        .filter((fact) => fact.streamId === `work:${scope.workItemId}`),
    ).toHaveLength(1);
  });

  test("recovers the terminal-CAS-to-attempt-close crash exactly once", async () => {
    const scope = await fixture("d-cas-close", passingVerifier);
    const terminal = await scope.coordinator.settleAssign({
      admitted: scope.admitted,
      record: scope.record,
      outcome: completed,
      at: NOW,
    });
    expect(DelegationStore.settleOnce(scope.record.delegationId, terminal).committed).toBe(true);
    let finishRecovery: (() => void) | undefined;
    const recovered = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const recoveringLinkage = {
      ...scope.workItems,
      recoverAttempts: async (lookup: (delegationId: string) => Delegation.Record | undefined) => {
        await scope.workItems.recoverAttempts(lookup);
        finishRecovery?.();
      },
    };
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => NOW + 1,
      newDelegationId: () => "unused",
      wake: () => undefined,
      workItems: recoveringLinkage,
      verification: scope.coordinator,
    });
    await recovered;
    const first = WorkItemStore.get(scope.workItemId);
    const firstRevision = first?.revision;
    kernel.stop();

    let finishSecond: (() => void) | undefined;
    const secondRecovery = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const secondKernel = createDelegationKernel({
      drivers: {},
      now: () => NOW + 2,
      newDelegationId: () => "unused",
      wake: () => undefined,
      workItems: {
        ...scope.workItems,
        recoverAttempts: async (lookup) => {
          await scope.workItems.recoverAttempts(lookup);
          finishSecond?.();
        },
      },
      verification: scope.coordinator,
    });
    await secondRecovery;
    secondKernel.stop();

    expect(first?.attemptTerminal).toMatchObject({ outcome: "succeeded" });
    expect(WorkItemStore.get(scope.workItemId)?.revision).toBe(firstRevision);
    expect(
      scope.adapter.ledger
        .factsByType("work_item.attempt_finished")
        .filter((fact) => fact.streamId === `work:${scope.workItemId}`),
    ).toHaveLength(1);
  });

  test("recovery refuses verifier facts recorded for an older attempt", async () => {
    // Given: attempt one recorded a verified result before attempt two became active.
    const scope = await fixture("d-old-facts", passingVerifier);
    const oldSettlement = await scope.coordinator.settleAssign({
      admitted: scope.admitted,
      record: scope.record,
      outcome: completed,
      at: NOW,
    });
    const attemptFact = scope.adapter.ledger
      .factsByType("work_item.attempt_allocated")
      .find((fact) => fact.streamId === `work:${scope.workItemId}`);
    if (attemptFact === undefined) throw new Error("fixture attempt fact missing");
    const { revision: _revision, ...attemptData } = attemptFact.data;
    const firstAttempt = WorkItem.Attempt.parse(attemptData);
    const second = await WorkItemStore.allocateAttempt(
      scope.workItemId,
      {
        contentFingerprint: firstAttempt.contentFingerprint,
        environmentFingerprint: firstAttempt.environmentFingerprint,
      },
      "trace-retry",
    );
    if (oldSettlement.status !== "verified" || second === undefined) {
      throw new Error("fixture attempt transition failed");
    }

    // When: restart recovery considers the old verifier facts.
    const recovered = scope.coordinator.recoverSettlement(scope.record, NOW + 1);

    // Then: facts from attempt one cannot settle attempt two.
    expect(second.item.attempt).toBe(1);
    expect(second.item.lastAttemptSeq).toBe(2);
    expect(recovered).toBeUndefined();
  });
});
