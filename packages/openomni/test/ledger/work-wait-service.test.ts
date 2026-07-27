import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Execution, type Ledger } from "@openomni/protocol";
import {
  createWorkWaitServices,
  type CompletionAdmissionDecisionV1,
  type CompletionClaimVerdictV1,
  type CompletionRecordV1,
  type WaitRecordV1,
  type WorkAttemptRecordV1,
  type WorkRecordV1,
  type WorkWaitCommitV1,
  type WorkWaitCommitResultV1,
} from "../../src/ledger/production/work-wait.js";

const environment = Execution.LLMEnvironmentV1.parse({
  version: "llm-environment-v1",
  catalogSchemaVersion: 1,
  catalogSource: "bundled",
  catalogSourceVersion: "1",
  catalogDigest: "a".repeat(64),
  modelDigest: "b".repeat(64),
  endpoint: {
    version: "llm-endpoint-ref-v1",
    kind: "default",
    valueRef: "openai",
    endpointDigest: "c".repeat(64),
  },
  credential: {
    version: "credential-source-ref-v1",
    providerId: "openai",
    authType: "api",
    credentialId: "test",
    rotationId: "1",
    sourceKind: "injected_runtime",
    sourcePathDigest: "d".repeat(64),
    credentialDigest: "e".repeat(64),
  },
  sdkPackage: "@ai-sdk/openai",
  adapterVersion: "1",
  environmentDigest: "f".repeat(64),
});

const effectScope = Execution.EffectScopeV1.parse({
  version: "effect-scope-v1",
  workspace: {
    canonicalizerVersion: "workspace-v1",
    workspaceId: `w1:${"1".repeat(64)}`,
    canonicalBytesDigest: "1".repeat(64),
  },
  resources: [{ version: "resource-scope-v1", kind: "workspace", target: "**" }],
  resolver: { id: "worker-dispatch", version: "v1", inputDigest: "2".repeat(64) },
  containment: "none",
  mutationClass: "unknown",
});

const work: WorkRecordV1 = {
  workItemId: "work-1",
  sessionId: "session-1",
  title: "work",
  status: "running",
  evidenceRefs: [],
  readbackRefs: [],
};
const attempt: WorkAttemptRecordV1 = {
  workItemId: work.workItemId,
  attemptId: "attempt-1",
  attemptSeq: 1,
  sessionId: work.sessionId,
  runId: "run-1",
  status: "running",
  title: "work",
  prompt: "do work",
  agentName: "worker",
  model: { provider: "openai", id: "gpt-test" },
  environment,
};
const attemptRef: Ledger.AttemptRefV1 = {
  version: "attempt-ref-v1",
  workItemId: work.workItemId,
  attemptId: attempt.attemptId,
  attemptSeq: attempt.attemptSeq,
};

function openInput(waitId = "wait-1") {
  return {
    waitId,
    ownerRef: {
      version: "wait-owner-ref-v1" as const,
      kind: "workItem" as const,
      id: work.workItemId,
    },
    expectedResponders: [{ version: "wait-responder-ref-v1" as const, actorId: "owner" }],
    correlation: { version: "wait-correlation-v1" as const, tokenHash: "1".repeat(64) },
    allowedActions: ["report_result" as const],
    route: { kind: "worker" as const, sessionId: attempt.sessionId, runId: attempt.runId },
    attempt: attemptRef,
    sessionId: attempt.sessionId,
  };
}

function harness(commit: (command: WorkWaitCommitV1) => Promise<WorkWaitCommitResultV1>) {
  let currentAttempt = attempt;
  let currentWork = work;
  let currentCompletion: CompletionRecordV1 | undefined;
  const effects = new Map<
    string,
    import("../../src/ledger/production/work-wait.js").EffectRecordV1
  >();
  let wait: WaitRecordV1 | undefined;
  const services = createWorkWaitServices(
    {
      async work(id) {
        return id === currentWork.workItemId ? currentWork : undefined;
      },
      async completion() {
        return currentCompletion;
      },
      async attempt(id) {
        return id === currentAttempt.attemptId ? currentAttempt : undefined;
      },
      async attemptByRunId(id) {
        return id === currentAttempt.runId ? currentAttempt : undefined;
      },
      async attemptsBySession() {
        return [attempt];
      },
      async wait(id) {
        return wait?.waitId === id ? wait : undefined;
      },
      async waitCandidates() {
        return wait === undefined ? [] : [wait];
      },
      async waitsByAttempt() {
        return wait === undefined ? [] : [wait];
      },
      async effect(id) {
        return effects.get(id);
      },
    },
    {
      async commit(command) {
        const result = await commit(command);
        if (result.transitionResult.status === "committed") {
          if ("wait" in command) wait = command.wait;
          if ("attempt" in command) currentAttempt = command.attempt;
          if ("work" in command) currentWork = command.work;
          if ("effect" in command) effects.set(command.effect.effectId, command.effect);
          if ("completion" in command) currentCompletion = command.completion;
        }
        return result.transitionResult.status === "committed" && "effectScope" in command
          ? {
              ...result,
              effectBinding: {
                effect: {
                  version: "effect-ref-v1",
                  effectId: command.effect.effectId,
                  idempotencyKey: command.effect.sourceRef,
                },
                effectScope: command.effectScope,
              },
            }
          : result;
      },
    },
    {
      model: attempt.model,
      modelEnvironment: environment,
      now: () => 1_000,
      workerEffectScope: () => effectScope,
    },
  );
  return {
    services,
    setWait(value: WaitRecordV1) {
      wait = value;
    },
    setAttempt(value: WorkAttemptRecordV1) {
      currentAttempt = value;
    },
    setWork(value: WorkRecordV1) {
      currentWork = value;
    },
    setCompletion(value: CompletionRecordV1) {
      currentCompletion = value;
    },
  };
}

const committed = async (): Promise<WorkWaitCommitResultV1> => ({
  transitionResult: {
    version: "kernel-transition-result-v1",
    status: "committed",
    receipt: {} as never,
  },
});
const rejected = async (): Promise<WorkWaitCommitResultV1> => ({
  transitionResult: {
    version: "kernel-transition-result-v1",
    status: "rejected",
    code: "transition_forbidden",
  },
});

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function semanticRequest(
  target: Awaited<
    ReturnType<ReturnType<typeof harness>["services"]["workerLedger"]["resolveWorkByRunId"]>
  >,
  requestId: string,
  content: unknown,
  evidenceRef: string,
) {
  if (target === undefined) throw new Error("worker target missing");
  const hashInput = {
    transitionId: "WI-07",
    target: {
      owner: target.owner,
      workItemId: target.workItemId,
      runId: target.runId,
      attempt: target.attempt,
    },
    evidenceRef,
    content,
    effectBinding: undefined,
  };
  return {
    transitionId: "WI-07" as const,
    requestId,
    requestHash: createHash("sha256").update(canonicalJson(hashInput)).digest("hex"),
    target,
    evidenceRef,
    content,
  };
}

function completionRequest(
  target: NonNullable<
    Awaited<
      ReturnType<ReturnType<typeof harness>["services"]["workerLedger"]["resolveWorkByRunId"]>
    >
  >,
  transitionId: "CP-02" | "CP-04",
  requestId: string,
  content: unknown,
  evidenceRef: string,
) {
  const hashInput = {
    transitionId,
    target: {
      owner: target.owner,
      workItemId: target.workItemId,
      runId: target.runId,
      attempt: target.attempt,
    },
    evidenceRef,
    content,
    effectBinding: undefined,
  };
  return {
    transitionId,
    requestId,
    requestHash: createHash("sha256").update(canonicalJson(hashInput)).digest("hex"),
    target,
    evidenceRef,
    content,
  };
}

const completionCandidate = {
  summary: "done",
  claims: [
    { statement: "first claim", evidenceIds: ["evidence-1"] },
    { statement: "second claim", evidenceIds: ["evidence-2"] },
  ],
  caveats: [],
  followUps: [],
};
const completionCandidateRef = createHash("sha256")
  .update(canonicalJson(completionCandidate))
  .digest("hex");
const completionRecord: CompletionRecordV1 = {
  workItemId: work.workItemId,
  status: "candidate",
  candidateRef: completionCandidateRef,
  verdictRefs: [],
  decisionRef: null,
  stakesAsOfLedgerSeq: 42,
  stakesAsOfDbMs: 1_000,
};

function claimVerdict(
  claimIndex: number,
  status: CompletionClaimVerdictV1["status"] = "passed",
  evidenceIds = completionCandidate.claims[claimIndex]?.evidenceIds ?? [],
): CompletionClaimVerdictV1 {
  const claim = completionCandidate.claims[claimIndex];
  if (claim === undefined) throw new Error("claim fixture missing");
  return {
    version: "completion-claim-verdict-v1",
    candidateRef: completionCandidateRef,
    candidate: completionCandidate,
    claimIndex,
    claimDigest: createHash("sha256").update(canonicalJson(claim)).digest("hex"),
    evidenceIds,
    status,
  };
}

function admissionDecision(
  verdicts: readonly CompletionClaimVerdictV1[],
): CompletionAdmissionDecisionV1 {
  return {
    version: "completion-admission-decision-v1",
    candidate: completionCandidate,
    candidateRef: completionCandidateRef,
    verdicts,
    verdictRefs: verdicts.map((verdict) =>
      createHash("sha256").update(canonicalJson(verdict)).digest("hex"),
    ),
    stakesAsOfLedgerSeq: completionRecord.stakesAsOfLedgerSeq,
    stakesAsOfDbMs: completionRecord.stakesAsOfDbMs,
    admission: {
      "AC-1": true,
      "AC-2": true,
      "AC-3": true,
      "AC-4": true,
      "AC-5": true,
      "AC-6": true,
    },
  };
}
describe("production Work/Wait commit semantics", () => {
  test("does not return a Wait when WT-01 is rejected", async () => {
    const { services } = harness(rejected);
    await expect(services.waitKernel.open(openInput())).rejects.toThrow("Wait open rejected");
  });

  test("rejects duplicate Wait IDs with different immutable bindings", async () => {
    const fixture = harness(committed);
    await fixture.services.waitKernel.open(openInput());
    await expect(
      fixture.services.waitKernel.open({
        ...openInput(),
        route: { kind: "worker", sessionId: attempt.sessionId, runId: "run-other" },
      }),
    ).rejects.toThrow("different immutable open bindings");
  });

  test("requires authoritative WorkItem, Attempt, and session bindings", async () => {
    const { services } = harness(committed);
    await expect(
      services.waitKernel.open({
        ...openInput(),
        ownerRef: { version: "wait-owner-ref-v1", kind: "session", id: attempt.sessionId },
      }),
    ).rejects.toThrow("exact WorkItem owner, Attempt, and session bindings");
  });

  test("resident.ask returns only after DP-15 committed and projected the exact Wait", async () => {
    const denied = harness(rejected);
    const input = {
      requestId: "ask-1",
      sourceSessionId: attempt.sessionId,
      sourceRunId: attempt.runId,
      targetSessionId: "resident-session",
      workItemId: attempt.workItemId,
      attemptId: attempt.attemptId,
      attemptSeq: attempt.attemptSeq,
      payload: "question",
    };
    await expect(
      denied.services.messagingWaitLifecycle.commands.openResidentAsk(input),
    ).rejects.toThrow("resident.ask open rejected");

    const accepted = harness(committed);
    await expect(
      accepted.services.messagingWaitLifecycle.commands.openResidentAsk(input),
    ).resolves.toMatchObject({ waitId: input.requestId });
  });

  test("resolved Wait resume never reports success when AT-12 is rejected", async () => {
    const fixture = harness(rejected);
    fixture.setAttempt({ ...attempt, status: "waiting" });
    fixture.setWait({
      ...openInput("wait-resolved"),
      revision: "2",
      opened: {
        version: "wait.opened.v1",
        waitId: "wait-resolved",
        ownerRef: openInput().ownerRef,
        expectedResponders: openInput().expectedResponders,
        correlation: openInput().correlation,
        allowedActions: openInput().allowedActions,
        resolutionPolicy: "first-response",
        quorum: { version: "wait-quorum-v1", required: 1, total: 1 },
        status: "open",
        deadline: 2_000,
        partial: false,
        followUpWindow: 0,
        attempt: attemptRef,
      },
      status: "resolved",
      route: openInput().route,
      workItemId: work.workItemId,
      attemptId: attempt.attemptId,
      sessionId: attempt.sessionId,
      responses: [],
      ambiguities: [],
      resolved: {
        version: "wait.resolved.v1",
        waitId: "wait-resolved",
        ownerRef: openInput().ownerRef,
        responseEventIds: ["response-1"],
        quorum: { version: "wait-quorum-v1", required: 1, total: 1 },
        partial: false,
        resolvedAtDbMs: 999,
      },
    });

    await expect(
      fixture.services.messagingWaitLifecycle.commands.resumeAfterResolvedWait("wait-resolved"),
    ).rejects.toThrow("resident.ask resume intent rejected");
  });

  test("commits WI-07 only for exact read-back content and Attempt/Work/session binding", async () => {
    const commands: WorkWaitCommitV1[] = [];
    const fixture = harness(async (command) => {
      commands.push(command);
      return committed();
    });
    const target = await fixture.services.workerLedger.resolveWorkByRunId(attempt.runId);
    const readback = {
      kind: "url_fetch",
      target: "https://example.com/result",
      passed: true,
      observedAt: 1,
      statusCode: 200,
      contentDigest: "body-digest",
    };
    const readbackRef = createHash("sha256").update(canonicalJson(readback)).digest("hex");
    const result = await fixture.services.workerLedger.commitSemanticTransition(
      semanticRequest(target, "readback-1", readback, readbackRef),
    );
    expect(result.transitionResult).toMatchObject({ status: "committed" });
    expect(commands).toEqual([
      expect.objectContaining({
        transitionId: "WI-07",
        readbackRef,
        attempt: expect.objectContaining({
          attemptId: attempt.attemptId,
          sessionId: attempt.sessionId,
        }),
        work: expect.objectContaining({ readbackRefs: [readbackRef] }),
      }),
    ]);
    await expect(
      fixture.services.workerLedger.resolveWorkByRunId(attempt.runId),
    ).resolves.toMatchObject({
      readbackRefs: [readbackRef],
    });

    const duplicateTarget = await fixture.services.workerLedger.resolveWorkByRunId(attempt.runId);
    await expect(
      fixture.services.workerLedger.commitSemanticTransition(
        semanticRequest(duplicateTarget, "readback-duplicate", readback, readbackRef),
      ),
    ).resolves.toMatchObject({
      transitionResult: { status: "rejected", code: "idempotency_mismatch" },
    });
  });

  test("rejects forged WI-07 hashes and cross-session Attempt bindings", async () => {
    const fixture = harness(committed);
    const target = await fixture.services.workerLedger.resolveWorkByRunId(attempt.runId);
    const readback = {
      kind: "url_fetch",
      target: "https://example.com/result",
      passed: false,
      observedAt: 1,
    };
    await expect(
      fixture.services.workerLedger.commitSemanticTransition(
        semanticRequest(target, "readback-forged", readback, "f".repeat(64)),
      ),
    ).resolves.toMatchObject({
      transitionResult: { status: "rejected", code: "identity_mismatch" },
    });

    fixture.setAttempt({ ...attempt, sessionId: "session-forged" });
    const mismatchedTarget = await fixture.services.workerLedger.resolveWorkByRunId(attempt.runId);
    const readbackRef = createHash("sha256").update(canonicalJson(readback)).digest("hex");
    await expect(
      fixture.services.workerLedger.commitSemanticTransition(
        semanticRequest(mismatchedTarget, "readback-cross-session", readback, readbackRef),
      ),
    ).resolves.toMatchObject({
      transitionResult: { status: "rejected", code: "identity_mismatch" },
    });
  });

  test("admits completion only after exact complete passing verdict coverage", async () => {
    const commands: WorkWaitCommitV1[] = [];
    const fixture = harness(async (command) => {
      commands.push(command);
      return committed();
    });
    fixture.setCompletion(completionRecord);
    const target = await fixture.services.workerLedger.resolveWorkByRunId(attempt.runId);
    if (target === undefined) throw new Error("worker target missing");

    const missing = admissionDecision([]);
    await expect(
      fixture.services.workerLedger.commitSemanticTransition(
        completionRequest(
          target,
          "CP-04",
          "completion-missing",
          missing,
          createHash("sha256").update(canonicalJson(missing)).digest("hex"),
        ),
      ),
    ).resolves.toMatchObject({ transitionResult: { status: "rejected" } });

    await expect(
      fixture.services.workerLedger.commitSemanticTransition(
        completionRequest(
          target,
          "CP-02",
          "verdict-arbitrary-ref",
          claimVerdict(0),
          "f".repeat(64),
        ),
      ),
    ).resolves.toMatchObject({ transitionResult: { status: "rejected" } });

    const verdicts = [claimVerdict(0), claimVerdict(1)];
    for (const [index, verdict] of verdicts.entries()) {
      const verdictRef = createHash("sha256").update(canonicalJson(verdict)).digest("hex");
      await expect(
        fixture.services.workerLedger.commitSemanticTransition(
          completionRequest(target, "CP-02", `verdict-${index}`, verdict, verdictRef),
        ),
      ).resolves.toMatchObject({ transitionResult: { status: "committed" } });
    }
    const decision = admissionDecision(verdicts);
    const verdictRefs = verdicts.map((verdict) =>
      createHash("sha256").update(canonicalJson(verdict)).digest("hex"),
    );
    const decisionRef = createHash("sha256").update(canonicalJson(decision)).digest("hex");
    expect(new Set([completionCandidateRef, ...verdictRefs, decisionRef]).size).toBe(4);
    expect(
      commands
        .filter((command) => command.transitionId === "CP-02")
        .map((command) => ("verdictRef" in command ? command.verdictRef : undefined)),
    ).toEqual(verdictRefs);
    await expect(
      fixture.services.workerLedger.commitSemanticTransition(
        completionRequest(target, "CP-04", "completion-admit", decision, decisionRef),
      ),
    ).resolves.toMatchObject({ transitionResult: { status: "committed" } });
    expect(commands.at(-1)).toMatchObject({
      transitionId: "CP-04",
      work: { status: "completed" },
      completion: { status: "admitted" },
    });
    expect(commands.at(-1)).toMatchObject({
      decisionRef,
      completion: { candidateRef: completionCandidateRef, verdictRefs, decisionRef },
    });
  });

  test("rejects duplicate, wrong-claim/evidence, failed, pending, and blocked coverage", async () => {
    const cases = [
      { name: "duplicate", verdicts: [claimVerdict(0), claimVerdict(0)] },
      {
        name: "wrong claim",
        verdicts: [{ ...claimVerdict(0), claimDigest: "wrong-claim" }, claimVerdict(1)],
      },
      {
        name: "wrong evidence",
        verdicts: [claimVerdict(0, "passed", ["evidence-other"]), claimVerdict(1)],
      },
      { name: "failed", verdicts: [claimVerdict(0, "failed"), claimVerdict(1)] },
      { name: "pending", verdicts: [claimVerdict(0, "pending"), claimVerdict(1)] },
    ] as const;
    for (const scenario of cases) {
      const fixture = harness(committed);
      const refs = scenario.verdicts.map((verdict) =>
        createHash("sha256").update(canonicalJson(verdict)).digest("hex"),
      );
      fixture.setCompletion({ ...completionRecord, verdictRefs: refs });
      const target = await fixture.services.workerLedger.resolveWorkByRunId(attempt.runId);
      if (target === undefined) throw new Error("worker target missing");
      const decision = admissionDecision(scenario.verdicts);
      await expect(
        fixture.services.workerLedger.commitSemanticTransition(
          completionRequest(
            target,
            "CP-04",
            `completion-${scenario.name}`,
            decision,
            createHash("sha256").update(canonicalJson(decision)).digest("hex"),
          ),
        ),
      ).resolves.toMatchObject({ transitionResult: { status: "rejected" } });
    }

    const blocked = harness(committed);
    const verdicts = [claimVerdict(0), claimVerdict(1)];
    blocked.setCompletion({
      ...completionRecord,
      verdictRefs: verdicts.map((verdict) =>
        createHash("sha256").update(canonicalJson(verdict)).digest("hex"),
      ),
    });
    blocked.setWork({ ...work, activeBlockerRefs: ["blocker-1"] });
    const target = await blocked.services.workerLedger.resolveWorkByRunId(attempt.runId);
    if (target === undefined) throw new Error("worker target missing");
    const decision = admissionDecision(verdicts);
    await expect(
      blocked.services.workerLedger.commitSemanticTransition(
        completionRequest(
          target,
          "CP-04",
          "completion-blocked",
          decision,
          createHash("sha256").update(canonicalJson(decision)).digest("hex"),
        ),
      ),
    ).resolves.toMatchObject({ transitionResult: { status: "rejected" } });
  });
});
