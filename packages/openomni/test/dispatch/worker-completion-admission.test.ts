import { beforeEach, describe, expect, test } from "bun:test";
import { PolicyEngine } from "@openomni/policy";
import { type Execution, WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/session";
import {
  type ConnectorCompletionOptions,
  projectConnectorCompletion as projectConnectorCompletionWithPolicy,
} from "../../src/dispatch/handlers/connector-completion-projector.js";
import { Stakes } from "../../src/ledger/index.js";
import {
  reflectCoordinatorResult as reflectCoordinatorResultWithPolicy,
  type WorkerCompletionOptions,
} from "../../src/dispatch/handlers/worker-completion.js";

const NOW = 1_000;
const COMPLETION_POLICY_ENGINE = PolicyEngine.create();

function reflectCoordinatorResult(
  workItemHash: string,
  result: Execution.Result,
  options: Omit<WorkerCompletionOptions, "completionPolicyEngine">,
) {
  return reflectCoordinatorResultWithPolicy(workItemHash, result, {
    ...options,
    completionPolicyEngine: COMPLETION_POLICY_ENGINE,
  });
}

function projectConnectorCompletion(
  workItemHash: string,
  result: Execution.Result,
  options: Omit<ConnectorCompletionOptions, "completionPolicyEngine">,
) {
  return projectConnectorCompletionWithPolicy(workItemHash, result, {
    ...options,
    completionPolicyEngine: COMPLETION_POLICY_ENGINE,
  });
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

async function startedItem(
  executorKind: WorkItem.ExecutorKind,
  criterionStatement = "recorded numeric operands satisfy eq",
): Promise<WorkItem.Info> {
  const created = await WorkItemStore.create({
    name: `Completion ${executorKind}`,
    sourceMessageId: `dispatch:${executorKind}`,
    sourceChannel: "dispatch",
    intent: "worker.spawn",
    goal: "prove completion admission convergence",
    executorKind,
    acceptanceCriteria: [criterionStatement],
  });
  const started = await WorkItemStore.start(created.hash);
  if (!started) throw new Error("missing started work item");
  return started;
}

async function evidenceBackedEnvelope(
  hash: string,
  verification: Readonly<{
    kind: string;
    recordedInputs: Readonly<Record<string, unknown>>;
  }> = {
    kind: "numeric_recheck",
    recordedInputs: { operator: "eq", left: 1, right: 1 },
  },
): Promise<string> {
  const current = WorkItemStore.get(hash);
  const criterion = current?.completionFacts.criteria[0];
  if (!current || !criterion) throw new Error("missing completion fixture");
  const withEvidence = await WorkItemStore.addEvidence(hash, {
    kind: "test_result",
    description: "kernel-recorded verifier input",
    passed: true,
    detail: JSON.stringify({
      type: "verifier_recorded_inputs",
      version: 1,
      workItemHash: current.hash,
      basisRef: current.completionContract.basisRef,
      criterionId: criterion.id,
      verifierKind: verification.kind,
      recordedInputs: verification.recordedInputs,
    }),
  });
  const evidenceId = withEvidence?.evidence.at(-1)?.id;
  if (!evidenceId) throw new Error("missing completion fixture");
  return JSON.stringify({
    completionReport: {
      summary: "Completed through the admission boundary.",
      claims: [{ statement: criterion.statement, evidenceIds: [evidenceId] }],
    },
    criterionFacts: [
      {
        criterionIndex: 0,
        evidenceRefs: [{ source: "work_item", evidenceId }],
        verification: { kind: verification.kind },
      },
    ],
  });
}

function succeeded(output: string): Execution.Result {
  return {
    runId: "run:completion-admission",
    sessionId: "session:completion-admission",
    status: "succeeded",
    output,
  };
}

describe("worker completion admission convergence", () => {
  test("admits one real internal worker result and links its terminal receipt", async () => {
    const item = await startedItem("internal_chat_agent");

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(await evidenceBackedEnvelope(item.hash)),
      {
        sourceOrigin: { source: "internal_worker" },
        now: () => NOW,
      },
    );

    const stored = WorkItemStore.get(item.hash);
    const admission = stored?.completionFacts.admissions[0];
    expect(reflection).toMatchObject({ workItemStatus: "completed", completionBlocked: false });
    expect(stored?.completionFacts.results[0]).toMatchObject({
      value: "verified",
      verifierRef: "builtin.numeric-v1",
      checkedPredicate: "recorded numeric operands satisfy eq",
    });
    expect(stored?.completionFacts.claims[0]?.statement).toBe(
      stored?.completionFacts.criteria[0]?.statement,
    );
    expect(stored?.completionFacts.observations[0]).toMatchObject({
      artifactRefs: [stored?.evidence[0]?.id],
      provenanceRef: stored?.evidence[0]?.id,
    });
    expect(admission).toMatchObject({
      origin: "worker",
      decision: "admit",
      policyRef: "agent.policy.composed",
    });
    expect(stored?.completionTerminalReceipt).toMatchObject({
      admissionId: admission?.id,
      requestId: admission?.requestId,
      contractRevision: stored?.completionContract.revision,
      basisRef: stored?.completionContract.basisRef,
    });
  });

  test("rejects an unrelated claimant statement for an indexed criterion", async () => {
    const item = await startedItem("internal_chat_agent");
    const parsed = JSON.parse(await evidenceBackedEnvelope(item.hash)) as {
      criterionFacts: Array<Record<string, unknown>>;
    };
    const fact = parsed.criterionFacts[0];
    if (!fact) throw new Error("missing criterion fact");
    fact.statement = "One equals one, therefore production was deployed.";

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(JSON.stringify(parsed)),
      { sourceOrigin: { source: "internal_worker" }, now: () => NOW },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
    expect(stored?.completionTerminalReceipt).toBeUndefined();
  });

  test("blocks a passing executable predicate unrelated to the persisted criterion", async () => {
    const item = await startedItem("internal_chat_agent", "deploy production");

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(await evidenceBackedEnvelope(item.hash)),
      { sourceOrigin: { source: "internal_worker" }, now: () => NOW },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.verificationErrors[0]).toMatchObject({
      code: "malformed_output",
      criterionId: stored?.completionFacts.criteria[0]?.id,
    });
    expect(stored?.completionFacts.admissions[0]).toMatchObject({
      decision: "block",
      reasonCodes: expect.arrayContaining(["verification_error"]),
    });
    expect(stored?.completionTerminalReceipt).toBeUndefined();
    expect(stored?.completionReport).toBeUndefined();
  });

  test("allows citation support because it evaluates the persisted criterion claim", async () => {
    const statement = "The release passed all checks.";
    const item = await startedItem("internal_chat_agent", statement);

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(
        await evidenceBackedEnvelope(item.hash, {
          kind: "citation_support",
          recordedInputs: { archivedText: statement },
        }),
      ),
      { sourceOrigin: { source: "internal_worker" }, now: () => NOW },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection).toMatchObject({ workItemStatus: "completed", completionBlocked: false });
    expect(stored?.completionFacts.results[0]).toMatchObject({
      value: "verified",
      verifierRef: "builtin.frozen-symbolic-nli-v1",
      checkedPredicate:
        "frozen symbolic NLI relation and directional lexical support agree with the citation",
    });
    expect(stored?.completionFacts.claims[0]?.statement).toBe(statement);
    expect(stored?.completionTerminalReceipt).toBeDefined();
  });

  test("routes connector Worker completion through the same durable admission boundary", async () => {
    const item = await startedItem("connector_endpoint");

    const projection = await projectConnectorCompletion(
      item.hash,
      succeeded(await evidenceBackedEnvelope(item.hash)),
      { now: () => NOW },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(projection.reflection).toMatchObject({
      workItemStatus: "completed",
      completionBlocked: false,
    });
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored?.completionFacts.admissions[0]).toMatchObject({
      origin: "worker",
      decision: "admit",
    });
    expect(stored?.completionTerminalReceipt?.admissionId).toBe(
      stored?.completionFacts.admissions[0]?.id,
    );
  });

  test("rejects duplicate criterion facts before verifier execution regardless of conflicting input order", async () => {
    for (const recordedInputs of [
      [
        { operator: "eq", left: 1, right: 1 },
        { operator: "eq", left: 1, right: 2 },
      ],
      [
        { operator: "eq", left: 1, right: 2 },
        { operator: "eq", left: 1, right: 1 },
      ],
    ]) {
      Storage.reset();
      Storage.initialize({ dbPath: ":memory:" });
      const item = await startedItem("internal_chat_agent");
      const criterion = item.completionFacts.criteria[0];
      if (!criterion) throw new Error("missing completion criterion");

      const evidenceIds: string[] = [];
      for (const inputs of recordedInputs) {
        const withEvidence = await WorkItemStore.addEvidence(item.hash, {
          kind: "test_result",
          description: "conflicting durable verifier input",
          passed: inputs.right === 1,
          detail: JSON.stringify({
            type: "verifier_recorded_inputs",
            version: 1,
            workItemHash: item.hash,
            basisRef: item.completionContract.basisRef,
            criterionId: criterion.id,
            verifierKind: "numeric_recheck",
            recordedInputs: inputs,
          }),
        });
        const evidenceId = withEvidence?.evidence.at(-1)?.id;
        if (!evidenceId) throw new Error("missing verifier evidence");
        evidenceIds.push(evidenceId);
      }
      const output = JSON.stringify({
        completionReport: {
          summary: "Conflicting duplicate facts must not choose a winner.",
          claims: [{ statement: criterion.statement, evidenceIds }],
        },
        criterionFacts: evidenceIds.map((evidenceId) => ({
          criterionIndex: 0,
          evidenceRefs: [{ source: "work_item", evidenceId }],
          verification: { kind: "numeric_recheck" },
        })),
        readBackRequests: [
          {
            claimIndex: 0,
            criterionIndex: 0,
            request: {
              kind: "citation_match",
              target: "http://example.com/never-read",
              quotedText: "duplicate facts reject before read-back",
            },
          },
        ],
      });
      let readBackExecuted = false;

      const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
        sourceOrigin: { source: "internal_worker" },
        now: () => NOW,
        async readBackRecorder() {
          readBackExecuted = true;
          throw new Error("read-back must not execute");
        },
      });

      const stored = WorkItemStore.get(item.hash);
      expect(reflection.completionBlocked).toBe(true);
      expect(reflection.completionBlocker).toContain("criterionIndex 0");
      expect(readBackExecuted).toBe(false);
      expect(stored?.completionFacts).toMatchObject({
        results: [],
        claims: [],
        observations: [],
        verificationErrors: [],
        admissions: [],
      });
      expect(stored?.completionReport).toBeUndefined();
      expect(stored?.completionTerminalReceipt).toBeUndefined();
    }
  });

  test("rejects cross-criterion reuse of one read-back evidence binding", async () => {
    const predicate = "archived source contains the recorded quote exactly";
    const created = await WorkItemStore.create({
      name: "Cross-criterion read-back binding",
      sourceMessageId: "dispatch:cross-criterion-read-back",
      sourceChannel: "dispatch",
      intent: "worker.spawn",
      goal: "prove criterion-local read-back binding",
      executorKind: "internal_chat_agent",
      acceptanceCriteria: [predicate, predicate],
    });
    const item = await WorkItemStore.start(created.hash);
    if (!item) throw new Error("missing started WorkItem");
    const output = JSON.stringify({
      completionReport: {
        summary: "One read-back cannot satisfy two criterion IDs.",
        claims: [{ statement: predicate }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "archived_quote_match" },
        },
        {
          criterionIndex: 1,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "archived_quote_match" },
        },
      ],
      readBackRequests: [
        {
          claimIndex: 0,
          criterionIndex: 0,
          request: {
            kind: "citation_match",
            target: "http://example.com/read-back",
            quotedText: "bound marker",
          },
        },
      ],
    });

    const reflection = await reflectCoordinatorResultWithPolicy(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine: COMPLETION_POLICY_ENGINE,
      now: () => NOW,
      async readBackRecorder(hash, request) {
        if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
        return WorkItemStore.addReadBackEvidence(hash, {
          kind: "citation_match",
          target: request.target,
          quotedText: request.quotedText,
          matchedText: request.quotedText,
          passed: true,
          observedAt: NOW,
          statusCode: 200,
        });
      },
    });

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("criterion binding");
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionTerminalReceipt).toBeUndefined();
    expect(stored?.completionReport).toBeUndefined();
  });

  test("rejects unknown authority-shaped completion envelope fields", async () => {
    const cases = [
      {
        name: "top-level",
        mutate(envelope: Record<string, unknown>) {
          envelope.policyDecision = "allow";
        },
      },
      {
        name: "completion report",
        mutate(envelope: Record<string, unknown>) {
          const report = envelope.completionReport as Record<string, unknown>;
          report.admissionId = "claimant:admission";
        },
      },
      {
        name: "completion claim",
        mutate(envelope: Record<string, unknown>) {
          const report = envelope.completionReport as { claims: Array<Record<string, unknown>> };
          const claim = report.claims[0];
          if (!claim) throw new Error("missing completion claim");
          claim.verified = true;
        },
      },
    ] as const;

    for (const testCase of cases) {
      Storage.reset();
      Storage.initialize({ dbPath: ":memory:" });
      const item = await startedItem("internal_chat_agent");
      const envelope = JSON.parse(await evidenceBackedEnvelope(item.hash)) as Record<
        string,
        unknown
      >;
      testCase.mutate(envelope);

      const reflection = await reflectCoordinatorResult(
        item.hash,
        succeeded(JSON.stringify(envelope)),
        { sourceOrigin: { source: "internal_worker" }, now: () => NOW },
      );

      const stored = WorkItemStore.get(item.hash);
      expect(reflection.completionBlocked, testCase.name).toBe(true);
      expect(stored?.completionFacts.results, testCase.name).toEqual([]);
      expect(stored?.completionFacts.admissions, testCase.name).toEqual([]);
      expect(stored?.completionTerminalReceipt, testCase.name).toBeUndefined();
    }
  });

  test("blocks a succeeded Worker envelope with missing criterion facts", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = await evidenceBackedEnvelope(item.hash);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    Reflect.deleteProperty(parsed, "criterionFacts");

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(JSON.stringify(parsed)),
      {
        sourceOrigin: { source: "internal_worker" },
        now: () => NOW,
      },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("criterionFacts");
    expect(stored?.completionFacts.admissions).toEqual([]);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("blocked");
  });

  test("records verifier errors and blocks instead of trusting an invalid claimed fact", async () => {
    const item = await startedItem("internal_chat_agent");

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(
        await evidenceBackedEnvelope(item.hash, {
          kind: "numeric_recheck",
          recordedInputs: { operator: "eq", left: 1 },
        }),
      ),
      {
        sourceOrigin: { source: "internal_worker" },
        now: () => NOW,
      },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.verificationErrors[0]).toMatchObject({
      code: "malformed_input",
      criterionId: stored?.completionFacts.criteria[0]?.id,
    });
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions[0]).toMatchObject({
      decision: "block",
      reasonCodes: expect.arrayContaining(["verification_error"]),
    });
    expect(stored?.completionTerminalReceipt).toBeUndefined();
    expect(stored?.completionReport).toBeUndefined();
  });

  test("rejects claimant-fabricated inline verifier inputs", async () => {
    const item = await startedItem("internal_chat_agent");
    const withEvidence = await WorkItemStore.addEvidence(item.hash, {
      kind: "test_result",
      description: "terminal prose evidence only",
      passed: true,
    });
    const evidenceId = withEvidence?.evidence.at(-1)?.id;
    if (!evidenceId) throw new Error("missing terminal evidence");
    const output = JSON.stringify({
      completionReport: {
        summary: "Hostile claimant says the check passed.",
        claims: [{ statement: "Forged verification.", evidenceIds: [evidenceId] }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          verification: {
            kind: "numeric_recheck",
            recordedInputs: { operator: "eq", left: 7, right: 7 },
          },
        },
      ],
    });

    const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
    expect(stored?.completionTerminalReceipt).toBeUndefined();
  });

  test("rejects a missing WorkItem-local verifier evidence reference", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = JSON.stringify({
      completionReport: {
        summary: "Missing evidence must not verify.",
        claims: [{ statement: "Missing evidence.", evidenceIds: ["evidence:missing"] }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "work_item", evidenceId: "evidence:missing" }],
          verification: { kind: "numeric_recheck" },
        },
      ],
    });

    const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("verifier evidence not found");
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
  });

  test("rejects verifier evidence bound to a different criterion", async () => {
    const item = await startedItem("internal_chat_agent");
    const criterion = item.completionFacts.criteria[0];
    if (!criterion) throw new Error("missing criterion");
    const withEvidence = await WorkItemStore.addEvidence(item.hash, {
      kind: "verification",
      description: "mismatched verifier input",
      passed: true,
      detail: JSON.stringify({
        type: "verifier_recorded_inputs",
        version: 1,
        workItemHash: item.hash,
        basisRef: item.completionContract.basisRef,
        criterionId: `${criterion.id}:foreign`,
        verifierKind: "numeric_recheck",
        recordedInputs: { operator: "eq", left: 1, right: 1 },
      }),
    });
    const evidenceId = withEvidence?.evidence.at(-1)?.id;
    if (!evidenceId) throw new Error("missing evidence");
    const output = JSON.stringify({
      completionReport: {
        summary: "Mismatched evidence must not verify.",
        claims: [{ statement: "Mismatched evidence.", evidenceIds: [evidenceId] }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "work_item", evidenceId }],
          verification: { kind: "numeric_recheck" },
        },
      ],
    });

    const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("verifier evidence does not match criterion");
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
  });

  test("rejects claimant-supplied non-asserted values before authority evaluation", async () => {
    const item = await startedItem("internal_chat_agent");
    const parsed = JSON.parse(await evidenceBackedEnvelope(item.hash)) as {
      criterionFacts: Array<Record<string, unknown>>;
    };
    const fact = parsed.criterionFacts[0];
    if (!fact) throw new Error("missing criterion fact");
    fact.value = "verified";

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(JSON.stringify(parsed)),
      { sourceOrigin: { source: "internal_worker" }, now: () => NOW },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
  });

  test("carries kernel-computed Stakes into asserted-result escalation", async () => {
    const item = await startedItem("internal_chat_agent");
    const window = Stakes.createWindow({
      ownerKey: "owner:worker-completion",
      windowId: "window:worker-completion",
      openedAt: 1,
      closesAt: 10,
    });
    const stakes = Stakes.compute(
      {
        actionId: "action:worker-completion",
        ownerKey: window.ownerKey,
        windowRef: window.windowRef,
        ledgerObservedAt: 2,
        facts: {
          irreversibleChangeCount: 1,
          externalSurfaceCount: 0,
          spendMicros: 0,
          budgetReservedMicros: 0,
          outreachRecipientCount: 0,
          contentFingerprints: [
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ],
        },
      },
      { window, actions: [], knownFingerprints: [] },
    );
    let resolvedSubject: unknown;

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(
        await evidenceBackedEnvelope(item.hash, {
          kind: "reasoning",
          recordedInputs: {},
        }),
      ),
      {
        sourceOrigin: { source: "internal_worker" },
        stakesResolver: {
          resolve(subject) {
            resolvedSubject = subject;
            return {
              ok: true,
              context: { surface: "work.complete.pre", ...subject, stakes },
            };
          },
        },
        now: () => NOW,
      },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(resolvedSubject).toMatchObject({ workItemHash: item.hash });
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.results[0]).toMatchObject({ value: "asserted" });
    expect("checkedPredicate" in (stored?.completionFacts.results[0] ?? {})).toBe(false);
    expect(stored?.completionFacts.admissions[0]).toMatchObject({
      decision: "escalate",
      stakesRef: stakes.reference,
    });
    expect(stored?.completionTerminalReceipt).toBeUndefined();
  });
});
