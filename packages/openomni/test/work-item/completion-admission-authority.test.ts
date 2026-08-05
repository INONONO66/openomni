import { describe, expect, test } from "bun:test";
import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision, WorkItem } from "@openomni/protocol";
import * as Ledger from "../../src/ledger/index.js";
import {
  CompletionAdmissionError,
  createCompletionAuthorityResolver,
} from "../../src/work-item/completion-admission-authority.js";
import * as CompletionFold from "../../src/work-item/completion-admission-fold.js";
import * as WorkItemPublic from "../../src/work-item/index.js";

const criterion = {
  id: WorkItem.criterionId("wi_authority", 0, "Verify it"),
  revision: 1,
  statement: "Verify it",
  required: true,
} as const;

function item(overrides: Readonly<Record<string, unknown>> = {}): WorkItem.Info {
  const parsed = WorkItem.Info.safeParse({
    hash: "wi_authority",
    revision: 2,
    name: "Authority test",
    sourceMessageId: "msg_authority",
    sourceChannel: "test",
    attempt: 1,
    timestamps: { created: 1, updated: 1 },
    relations: { childHashes: [], dependsOn: [] },
    intent: "complete",
    goal: "lock admission authority",
    constraints: [],
    acceptanceCriteria: ["Verify it"],
    changedFiles: [],
    blockers: [],
    evidence: [],
    completionContract: { version: 1, revision: "contract:v1", basisRef: "basis:v1" },
    completionFacts: {
      ...WorkItem.emptyCompletionFacts(),
      revision: 2,
      criteria: [criterion],
    },
    ...overrides,
  });
  expect(parsed.success, "persisted WorkItem criteria must carry no risk authority").toBe(true);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

function assertedResult(): WorkItem.CriterionResult {
  return {
    id: "result:one",
    criterionId: criterion.id,
    value: "asserted",
    observationIds: [],
    assumptions: [],
    basisRef: "basis:v1",
    residualRisks: ["claimant-only evidence"],
    createdAt: 2,
  };
}

function observation(): WorkItem.Observation {
  return {
    id: "observation:one",
    producer: "verifier:test",
    subjectRef: "wi_authority",
    basisRef: "basis:v1",
    artifactRefs: [],
    ancestryRefs: [],
    observedAt: 2,
  };
}

function verifiedResult(
  value: "verified" | "refuted" | "inconclusive" = "verified",
): WorkItem.CriterionResult {
  return {
    ...assertedResult(),
    value,
    checkedPredicate: "verification holds",
    observationIds: ["observation:one"],
    verifierRef: "verifier:test",
    residualRisks: [],
  };
}

function hostileVerifiedResult(): WorkItem.CriterionResult {
  return {
    id: "result:hostile",
    criterionId: criterion.id,
    value: "verified",
    checkedPredicate: "hostile claimant verdict",
    observationIds: [],
    assumptions: [],
    basisRef: "basis:v1",
    residualRisks: [],
    createdAt: 3,
  };
}

function requestInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    version: 1,
    id: "request:completion",
    origin: "worker",
    workItemHash: "wi_authority",
    contractRevision: "contract:v1",
    basisRef: "basis:v1",
    expectedHead: 2,
    claims: [],
    observations: [],
    results: [assertedResult()],
    invalidations: [],
    verificationErrors: [],
    effects: [],
    ...overrides,
  };
}

function request(overrides: Readonly<Record<string, unknown>> = {}): WorkItem.CompletionRequest {
  const parsed = WorkItem.CompletionRequest.safeParse(requestInput(overrides));
  expect(parsed.success, "strict CompletionRequest must require numeric expectedHead").toBe(true);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

function requestWithOwnerReceipt(receiptRef: string): WorkItem.CompletionRequest | undefined {
  const parsed = WorkItem.CompletionRequest.safeParse(
    requestInput({ ownerOverrideReceiptRef: receiptRef }),
  );
  expect(
    parsed.success,
    "strict CompletionRequest must expose ownerOverrideReceiptRef as an optional candidate",
  ).toBe(true);
  if (!parsed.success) return undefined;
  return parsed.data;
}

function policyContext() {
  return {
    workItemHash: "wi_authority",
    requestId: "request:completion",
    contractRevision: "contract:v1",
    basisRef: "basis:v1",
    expectedHead: 2,
    completionCandidate: { effectiveResultIds: ["result:one"] },
    unresolvedBlockerIds: [],
    resourceDescriptor: {
      id: "work:wi_authority",
      kind: "work" as const,
      labels: [],
      capabilities: [],
      effects: [],
    },
  };
}

function admissionInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    version: 1,
    id: "admission:one",
    requestId: "request:completion",
    requestSnapshot: requestInput(),
    origin: "worker",
    contractRevision: "contract:v1",
    basisRef: "basis:v1",
    effectiveResultIds: ["result:one"],
    unresolvedCriterionIds: [],
    decision: "admit",
    reasonCodes: [],
    residualRisks: [],
    policyRef: "trusted:policy",
    expectedHead: 2,
    recordedHead: 3,
    createdAt: 10,
    ...overrides,
  };
}

function stakesInjection(
  subjectOverrides: Readonly<Record<string, unknown>> = {},
): Ledger.CompletionStakesInjection {
  const window = Ledger.Stakes.createWindow({
    ownerKey: "owner:authority",
    windowId: "window:authority",
    openedAt: 1,
    closesAt: 10,
  });
  const stakes = Ledger.Stakes.compute(
    {
      actionId: "action:authority",
      ownerKey: window.ownerKey,
      windowRef: window.windowRef,
      ledgerObservedAt: 2,
      facts: {
        irreversibleChangeCount: 10,
        externalSurfaceCount: 10,
        spendMicros: 100_000_000,
        budgetReservedMicros: 100_000_000,
        outreachRecipientCount: 10,
        contentFingerprints: [
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
      },
    },
    { window, actions: [], knownFingerprints: [] },
  );
  return {
    ok: true,
    context: {
      surface: "work.complete.pre",
      workItemHash: "wi_authority",
      requestId: "request:completion",
      contractRevision: "contract:v1",
      basisRef: "basis:v1",
      expectedHead: 2,
      stakes,
      ...subjectOverrides,
    },
  } as Ledger.CompletionStakesInjection;
}

function createPolicyEngine(
  options: Readonly<{
    allowAsserted?: boolean;
    deny?: boolean;
    denyReasonCodes?: readonly string[];
    pending?: boolean;
    abort?: boolean;
    observe?: (context: unknown) => void;
  }> = {},
) {
  const engine = PolicyEngine.create();
  if (options.allowAsserted) {
    engine.register({
      kind: "point",
      name: "criterion-allowance",
      pointIds: ["work.complete.pre"],
      effectCapabilities: { "work.complete.pre": ["work.allow_asserted"] },
      priority: 0,
      fn: (context) => {
        options.observe?.(context);
        return PolicyDecision.allow({
          policyId: "criterion-allowance",
          effects: [{ type: "work.allow_asserted", criterionIds: [criterion.id] }],
        });
      },
    });
  }
  if (options.deny) {
    engine.register({
      kind: "point",
      name: "deny-completion",
      pointIds: ["work.complete.pre"],
      effectCapabilities: { "work.complete.pre": [] },
      priority: 1,
      fn: () =>
        PolicyDecision.deny({
          policyId: "deny-completion",
          reasonCodes: [...(options.denyReasonCodes ?? ["work.completion_blocked"])],
        }),
    });
  }
  if (options.pending) {
    engine.register({
      kind: "point",
      name: "pending-completion",
      pointIds: ["work.complete.pre"],
      effectCapabilities: { "work.complete.pre": [] },
      priority: 1,
      fn: () => PolicyDecision.pending({ policyId: "pending-completion" }),
    });
  }
  if (options.abort) {
    engine.register({
      kind: "point",
      name: "abort-completion",
      pointIds: ["work.complete.pre"],
      effectCapabilities: { "work.complete.pre": ["run.abort"] },
      priority: 2,
      fn: () =>
        PolicyDecision.allow({
          policyId: "abort-completion",
          effects: [{ type: "run.abort", reason: "completion veto" }],
        }),
    });
  }
  return engine;
}

type ResolverDependencies = Readonly<{
  policyEngine: ReturnType<typeof PolicyEngine.create>;
  stakesResolver?: Readonly<{ resolve(subject: unknown): unknown }>;
  resultAuthorityPort?: Readonly<{ validate(candidate: unknown): unknown }>;
  ownerOverrideAuthorityPort?: Readonly<{ validate(candidate: unknown): unknown }>;
  now?: () => number;
}>;

function guardedResolver(dependencies: ResolverDependencies) {
  const resolver = Reflect.apply(createCompletionAuthorityResolver, undefined, [dependencies]);
  expect(typeof resolver, "factory must return a resolver object").toBe("object");
  if (typeof resolver !== "object" || resolver === null) return undefined;
  const resolve = Reflect.get(resolver, "resolve");
  expect(typeof resolve, "completion authority resolver must expose resolve(item, request)").toBe(
    "function",
  );
  if (typeof resolve !== "function") return undefined;

  return async (currentItem: WorkItem.Info, candidate: WorkItem.CompletionRequest) => {
    const output = await Reflect.apply(resolve, resolver, [currentItem, candidate]);
    const parsed = WorkItem.CompletionAdmission.safeParse(output);
    expect(parsed.success, "resolver must return a schema-valid CompletionAdmission").toBe(true);
    if (!parsed.success) return undefined;
    return parsed.data;
  };
}

async function resolveAdmission(
  dependencies: ResolverDependencies,
  currentItem: WorkItem.Info = item(),
  candidate: WorkItem.CompletionRequest = request(),
): Promise<WorkItem.CompletionAdmission | undefined> {
  const resolve = guardedResolver(dependencies);
  if (!resolve) return undefined;
  return resolve(currentItem, candidate);
}

async function resolveErrorCode(
  currentItem: WorkItem.Info,
  candidate: WorkItem.CompletionRequest,
  dependencies: ResolverDependencies = { policyEngine: createPolicyEngine() },
): Promise<unknown> {
  const resolve = guardedResolver(dependencies);
  if (!resolve) return undefined;
  try {
    await resolve(currentItem, candidate);
  } catch (error) {
    if (error instanceof CompletionAdmissionError) return error.code;
    throw error;
  }
  return undefined;
}

describe("completion admission authority resolver", () => {
  test("dispatches the actual policy point with a numeric row head and criterion scope", async () => {
    const decision = await createPolicyEngine({ allowAsserted: true }).dispatchPoint(
      "work.complete.pre",
      policyContext(),
    );

    expect(decision.verdict).toBe("allow");
    expect(decision.effects).toEqual([
      { type: "work.allow_asserted", criterionIds: [criterion.id] },
    ]);
  });

  test("keeps actual policy denial authoritative over asserted allowance", async () => {
    const decision = await createPolicyEngine({ allowAsserted: true, deny: true }).dispatchPoint(
      "work.complete.pre",
      policyContext(),
    );

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("work.completion_blocked");
    expect(decision.effects.some((effect) => effect.type === "work.allow_asserted")).toBe(false);
  });

  test("exports a closure factory whose resolver receives only item and strict request", () => {
    const resolve = guardedResolver({ policyEngine: createPolicyEngine(), now: () => 10 });

    expect(resolve).toBeDefined();
  });

  test("strict CompletionRequest requires a numeric expectedHead", () => {
    expect(WorkItem.CompletionRequest.safeParse(requestInput()).success).toBe(true);
  });

  test("CompletionAdmission records only expectedHead and recordedHead", () => {
    expect(WorkItem.CompletionAdmission.safeParse(admissionInput()).success).toBe(true);
  });

  test("the closure dispatches policy and applies criterion-scoped asserted allowance", async () => {
    let dispatchedContext: unknown;
    const policyEngine = createPolicyEngine({
      allowAsserted: true,
      observe: (context) => {
        dispatchedContext = context;
      },
    });

    const admission = await resolveAdmission({ policyEngine, now: () => 10 });

    expect(dispatchedContext).toMatchObject(policyContext());
    expect(admission?.decision).toBe("admit");
    expect(admission?.policyRef).toBe("agent.policy.composed");
  });

  test("the closure preserves policy denial over asserted allowance", async () => {
    const admission = await resolveAdmission({
      policyEngine: createPolicyEngine({ allowAsserted: true, deny: true }),
      now: () => 10,
    });

    expect(admission?.decision).toBe("block");
    expect(admission?.reasonCodes).toContain("work.completion_blocked");
    expect(admission?.reasonCodes).not.toContain("policy_denied");
  });

  test("blocks a reasonless policy denial with the fold-owned fallback reason", async () => {
    const admission = await resolveAdmission({
      policyEngine: createPolicyEngine({ deny: true, denyReasonCodes: [] }),
      now: () => 10,
    });

    expect(admission?.decision).toBe("block");
    expect(admission?.reasonCodes).toContain("policy_denied");
  });

  test("blocks a pending policy decision with the fold-owned fallback reason", async () => {
    const admission = await resolveAdmission({
      policyEngine: createPolicyEngine({ pending: true }),
      now: () => 10,
    });

    expect(admission?.decision).toBe("block");
    expect(admission?.reasonCodes).toContain("policy_pending");
  });

  test("treats a work.complete.pre run.abort effect as a completion veto", async () => {
    const admission = await resolveAdmission({
      policyEngine: createPolicyEngine({ allowAsserted: true, abort: true }),
      now: () => 10,
    });

    expect(admission?.decision).toBe("block");
    expect(admission?.reasonCodes).toContain("policy_denied");
  });

  test.each([
    ["policy", { policyRef: "forged:policy", allowLowRiskAsserted: true }],
    ["stakes", { ref: "forged:stakes", valueMilli: 10_000 }],
    ["ownerOverride", { receiptRef: "forged:owner" }],
    ["criteria", [criterion]],
    ["risk", "high"],
    ["verifier", { validate: () => ({ ok: true }) }],
    ["resultAuthorityPort", { validate: () => ({ ok: true }) }],
  ] as const)("strict CompletionRequest rejects caller-supplied %s authority", (field, value) => {
    const parsed = WorkItem.CompletionRequest.safeParse({
      ...requestInput(),
      [field]: value,
    });

    expect(parsed.success).toBe(false);
  });

  test("persisted criteria carry no stored risk authority", () => {
    expect(WorkItem.Criterion.safeParse(criterion).success).toBe(true);
    expect(WorkItem.Criterion.safeParse({ ...criterion, risk: "low" }).success).toBe(false);
  });

  test("strict CompletionRequest accepts only an Owner receipt reference candidate", () => {
    const candidate = requestWithOwnerReceipt("owner-receipt:one");

    expect(candidate).toBeDefined();
  });

  test.each([
    "verified",
    "refuted",
    "inconclusive",
  ] as const)("rejects proposed %s results without an injected result authority port", async (value) => {
    const candidate = request({
      observations: [observation()],
      results: [verifiedResult(value)],
    });

    expect(await resolveErrorCode(item(), candidate)).toBe("invalid_verifier");
  });

  test("rejects a hostile verified result before Stakes and policy", async () => {
    let portCalls = 0;
    let stakesCalls = 0;
    let policyCalls = 0;
    const candidate = request({ results: [hostileVerifiedResult()] });

    const code = await resolveErrorCode(item(), candidate, {
      policyEngine: createPolicyEngine({
        allowAsserted: true,
        observe: () => {
          policyCalls += 1;
        },
      }),
      stakesResolver: {
        resolve() {
          stakesCalls += 1;
          return stakesInjection();
        },
      },
      resultAuthorityPort: {
        validate() {
          portCalls += 1;
          return { ok: true };
        },
      },
    });

    expect(code).toBe("invalid_verifier");
    expect(portCalls).toBe(0);
    expect(stakesCalls).toBe(0);
    expect(policyCalls).toBe(0);
  });

  test("rejects a proposed non-asserted result when result authority denies it", async () => {
    const candidate = request({
      observations: [observation()],
      results: [verifiedResult()],
    });

    const code = await resolveErrorCode(item(), candidate, {
      policyEngine: createPolicyEngine(),
      resultAuthorityPort: { validate: () => ({ ok: false }) },
    });

    expect(code).toBe("invalid_verifier");
  });

  test("passes proposed non-asserted results to bound result authority", async () => {
    const proposedObservation = observation();
    const proposedResult = verifiedResult();
    let validatedCandidate: unknown;

    const admission = await resolveAdmission(
      {
        policyEngine: createPolicyEngine(),
        resultAuthorityPort: {
          validate(candidate: unknown) {
            validatedCandidate = candidate;
            return { ok: true };
          },
        },
        now: () => 10,
      },
      item(),
      request({ observations: [proposedObservation], results: [proposedResult] }),
    );

    expect(validatedCandidate).toEqual({
      workItemHash: "wi_authority",
      requestId: "request:completion",
      contractRevision: "contract:v1",
      basisRef: "basis:v1",
      criterion,
      result: proposedResult,
      observations: [proposedObservation],
    });
    expect(admission?.decision).toBe("admit");
  });

  test("rejects claim observations not bound to a criterion result", async () => {
    const forgedObservationId = "observation:forged-provenance";
    const candidate = request({
      claims: [
        {
          id: "claim:forged-provenance",
          criterionId: criterion.id,
          statement: "unrelated artifact proves completion",
          observationIds: [forgedObservationId],
          basisRef: "basis:v1",
          createdAt: 10,
        },
      ],
      observations: [
        observation(),
        {
          ...observation(),
          id: forgedObservationId,
          artifactRefs: ["evidence:unrelated"],
          provenanceRef: "evidence:unrelated",
        },
      ],
      results: [verifiedResult()],
    });

    const code = await resolveErrorCode(item(), candidate, {
      policyEngine: createPolicyEngine(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
    });

    expect(code).toBe("invalid_verifier");
  });

  test("rejects durable decisive results without authoritative verifier basis", async () => {
    const currentItem = item({
      completionFacts: {
        ...WorkItem.emptyCompletionFacts(),
        revision: 2,
        criteria: [criterion],
        results: [hostileVerifiedResult()],
      },
    });

    const code = await resolveErrorCode(currentItem, request({ results: [] }), {
      policyEngine: createPolicyEngine(),
      now: () => 10,
    });

    expect(code).toBe("invalid_verifier");
  });

  test("acquires Stakes before policy and includes the typed kernel value in the candidate", async () => {
    const order: string[] = [];
    let dispatchedContext: unknown;
    const injection = stakesInjection();
    const policyEngine = createPolicyEngine({
      allowAsserted: true,
      observe: (context) => {
        order.push("policy");
        dispatchedContext = context;
      },
    });

    const admission = await resolveAdmission({
      policyEngine,
      stakesResolver: {
        resolve() {
          order.push("stakes");
          return injection;
        },
      },
      now: () => 10,
    });

    expect(order).toEqual(["stakes", "policy"]);
    expect(dispatchedContext).toMatchObject({
      completionCandidate: {
        effectiveResultIds: ["result:one"],
        unresolvedCriterionIds: [criterion.id],
        reasonCodes: ["high_risk_asserted", "stakes_required"],
        assertedCriterionIds: [criterion.id],
        proposedFactIds: ["result:one"],
        stakes: {
          ref: injection.ok ? injection.context.stakes.reference : "unreachable",
          valueMilli: injection.ok ? injection.context.stakes.value : -1,
          comparison: injection.ok ? injection.context.stakes.comparison : "below",
        },
      },
    });
    expect(admission?.decision).toBe("escalate");
  });

  test("does not acquire Stakes when the pre-fold has no asserted result", async () => {
    let resolverCalls = 0;

    const admission = await resolveAdmission(
      {
        policyEngine: createPolicyEngine(),
        stakesResolver: {
          resolve() {
            resolverCalls += 1;
            return stakesInjection();
          },
        },
        resultAuthorityPort: { validate: () => ({ ok: true }) },
        now: () => 10,
      },
      item(),
      request({ observations: [observation()], results: [verifiedResult()] }),
    );

    expect(resolverCalls).toBe(0);
    expect(admission?.decision).toBe("admit");
    expect(admission?.stakesRef).toBeUndefined();
  });

  test("acquires Stakes for an asserted criterion not allowed by policy", async () => {
    let resolvedSubject: unknown;

    const admission = await resolveAdmission(
      {
        policyEngine: createPolicyEngine(),
        stakesResolver: {
          resolve(subject: unknown) {
            resolvedSubject = subject;
            return stakesInjection();
          },
        },
        now: () => 10,
      },
      item(),
      request(),
    );

    expect(resolvedSubject).toMatchObject({
      workItemHash: "wi_authority",
      requestId: "request:completion",
      contractRevision: "contract:v1",
      basisRef: "basis:v1",
      expectedHead: 2,
    });
    expect(admission?.decision).toBe("escalate");
    expect(admission?.stakesRef).toStartWith("sha256:");
  });

  test.each([
    ["surface", "invalid_subject", { surface: "authorized_voice" }],
    ["workItemHash", "invalid_subject", { workItemHash: "wi_other" }],
    ["requestId", "invalid_subject", { requestId: "request:other" }],
    ["contractRevision", "stale_basis", { contractRevision: "contract:other" }],
    ["basisRef", "stale_basis", { basisRef: "basis:other" }],
    ["expectedHead", "stale_head", { expectedHead: 3 }],
  ] as const)("rejects a same-hash Stakes success with mismatched %s before policy", async (_field, expectedCode, contextOverrides) => {
    let policyCalls = 0;

    const code = await resolveErrorCode(item(), request(), {
      policyEngine: createPolicyEngine({
        allowAsserted: true,
        observe: () => {
          policyCalls += 1;
        },
      }),
      stakesResolver: { resolve: () => stakesInjection(contextOverrides) },
    });

    expect(code).toBe(expectedCode);
    expect(policyCalls).toBe(0);
  });

  test("blocks an asserted criterion not allowed by policy when Stakes is not injected", async () => {
    const admission = await resolveAdmission(
      { policyEngine: createPolicyEngine(), now: () => 10 },
      item(),
      request(),
    );

    expect(admission?.decision).toBe("block");
    expect(admission?.stakesRef).toBeUndefined();
  });

  test("honors an Owner candidate only after the injected authority port validates its binding", async () => {
    const candidate = requestWithOwnerReceipt("owner-receipt:one");
    if (!candidate) return;
    let validatedCandidate: unknown;

    const admission = await resolveAdmission(
      {
        policyEngine: createPolicyEngine(),
        ownerOverrideAuthorityPort: {
          validate(input: unknown) {
            validatedCandidate = input;
            return { ok: true, receiptRef: "owner-receipt:one" } as const;
          },
        },
        now: () => 10,
      },
      item(),
      candidate,
    );

    expect(validatedCandidate).toEqual({
      receiptRef: "owner-receipt:one",
      workItemHash: "wi_authority",
      requestId: "request:completion",
      contractRevision: "contract:v1",
      basisRef: "basis:v1",
      expectedHead: 2,
    });
    expect(admission?.decision).toBe("owner_override");
    expect(admission?.ownerOverrideReceiptRef).toBe("owner-receipt:one");
  });

  test("does not honor an Owner candidate without an injected authority port", async () => {
    const candidate = requestWithOwnerReceipt("owner-receipt:one");
    if (!candidate) return;

    const admission = await resolveAdmission(
      { policyEngine: createPolicyEngine({ allowAsserted: true }), now: () => 10 },
      item(),
      candidate,
    );

    expect(admission?.decision).toBe("admit");
    expect(admission?.ownerOverrideReceiptRef).toBeUndefined();
  });

  test("rejects a caller attempt to invalidate a durable refuted result before policy", async () => {
    let policyCalls = 0;
    const refuted = {
      ...verifiedResult("refuted"),
      id: "result:durable-refuted",
    };
    const currentItem = item({
      completionFacts: {
        ...WorkItem.emptyCompletionFacts(),
        revision: 2,
        criteria: [criterion],
        observations: [observation()],
        results: [refuted],
      },
    });
    const candidate = request({
      invalidations: [
        {
          id: "invalidation:hostile-refuted",
          resultId: refuted.id,
          basisRef: "basis:v1",
          reason: "claimant wants the refutation ignored",
          createdAt: 3,
        },
      ],
    });

    const code = await resolveErrorCode(currentItem, candidate, {
      policyEngine: createPolicyEngine({
        allowAsserted: true,
        observe: () => {
          policyCalls += 1;
        },
      }),
    });

    expect(code).toBe("unsupported_fact");
    expect(policyCalls).toBe(0);
  });

  test("accepts invalidation only through its exact trusted authority binding", async () => {
    const refuted = {
      ...verifiedResult("refuted"),
      id: "result:durable-refuted",
    };
    const currentItem = item({
      completionFacts: {
        ...WorkItem.emptyCompletionFacts(),
        revision: 2,
        criteria: [criterion],
        observations: [observation()],
        results: [refuted],
      },
    });
    const invalidation = {
      id: "invalidation:trusted-refuted",
      resultId: refuted.id,
      basisRef: "basis:v1",
      reason: "trusted verifier withdrew its result",
      createdAt: 3,
    };
    let validatedCandidate: unknown;

    const admission = await resolveAdmission(
      {
        policyEngine: createPolicyEngine(),
        invalidationAuthorityPort: {
          validate(input: unknown) {
            validatedCandidate = input;
            return { ok: true } as const;
          },
        },
      },
      currentItem,
      request({ invalidations: [invalidation] }),
    );

    expect(validatedCandidate).toEqual({
      workItemHash: currentItem.hash,
      requestId: "request:completion",
      contractRevision: "contract:v1",
      basisRef: "basis:v1",
      expectedHead: 2,
      invalidation,
      result: refuted,
    });
    expect(admission?.requestSnapshot.invalidations).toEqual([invalidation]);
  });

  test("rejects requester verification errors without trusted verifier authority", async () => {
    const verificationError = {
      id: "verification-error:hostile",
      criterionId: criterion.id,
      code: "verifier_crash" as const,
      detail: "claimant says the verifier crashed",
      verifierRef: "verifier:claimed",
      basisRef: "basis:v1",
      createdAt: 99,
    };

    const code = await resolveErrorCode(
      item(),
      request({ results: [], verificationErrors: [verificationError] }),
    );

    expect(code).toBe("invalid_verifier");
  });

  test("rejects a caller attempt to settle a durable unknown effect before policy", async () => {
    let policyCalls = 0;
    const currentItem = item({
      completionFacts: {
        ...WorkItem.emptyCompletionFacts(),
        revision: 2,
        criteria: [criterion],
        effects: [
          {
            id: "effect:durable-unknown",
            attempt: 1,
            intentRef: "intent:publish",
            outcome: "unknown",
            createdAt: 2,
          },
        ],
      },
    });
    const candidate = request({
      effects: [
        {
          id: "effect:hostile-confirmed",
          attempt: 1,
          intentRef: "intent:publish",
          outcome: "confirmed",
          createdAt: 3,
        },
      ],
    });

    const code = await resolveErrorCode(currentItem, candidate, {
      policyEngine: createPolicyEngine({
        allowAsserted: true,
        observe: () => {
          policyCalls += 1;
        },
      }),
    });

    expect(code).toBe("unsupported_fact");
    expect(policyCalls).toBe(0);
  });

  test.each([
    ["invalid_subject", {}, { workItemHash: "wi_stale" }],
    ["stale_basis", {}, { basisRef: "basis:stale" }],
    ["stale_head", { revision: 3 }, {}],
  ] as const)("returns typed %s errors for stale persisted inputs", async (expected, itemOverrides, requestOverrides) => {
    expect(await resolveErrorCode(item(itemOverrides), request(requestOverrides))).toBe(expected);
  });

  test.each([
    [
      "claim basis",
      "stale_basis",
      {
        claims: [
          {
            id: "claim:stale",
            criterionId: criterion.id,
            statement: "stale claim",
            observationIds: [],
            basisRef: "basis:old",
            createdAt: 3,
          },
        ],
      },
    ],
    [
      "observation basis",
      "stale_basis",
      {
        observations: [
          {
            id: "observation:stale",
            producer: "worker:one",
            subjectRef: "wi_authority",
            basisRef: "basis:old",
            artifactRefs: [],
            ancestryRefs: [],
            observedAt: 3,
          },
        ],
      },
    ],
    ["result basis", "stale_basis", { results: [{ ...assertedResult(), basisRef: "basis:old" }] }],
    [
      "invalidation basis",
      "stale_basis",
      {
        invalidations: [
          {
            id: "invalidation:stale",
            resultId: "result:one",
            basisRef: "basis:old",
            reason: "stale invalidation",
            createdAt: 3,
          },
        ],
      },
    ],
    [
      "verification error basis",
      "stale_basis",
      {
        verificationErrors: [
          {
            id: "verification-error:stale",
            criterionId: criterion.id,
            code: "verifier_crash",
            detail: "stale verifier error",
            basisRef: "basis:old",
            createdAt: 3,
          },
        ],
      },
    ],
    [
      "observation subject",
      "invalid_subject",
      {
        observations: [
          {
            id: "observation:foreign",
            producer: "worker:one",
            subjectRef: "wi_other",
            basisRef: "basis:v1",
            artifactRefs: [],
            ancestryRefs: [],
            observedAt: 3,
          },
        ],
      },
    ],
    [
      "effect without authority",
      "unsupported_fact",
      {
        effects: [
          {
            id: "effect:foreign-attempt",
            attempt: 2,
            intentRef: "intent:publish",
            outcome: "unknown",
            createdAt: 3,
          },
        ],
      },
    ],
  ] as const)("rejects proposed %s before policy with typed %s", async (_name, expected, overrides) => {
    let policyCalls = 0;
    const policyEngine = createPolicyEngine({
      allowAsserted: true,
      observe: () => {
        policyCalls += 1;
      },
    });

    const code = await resolveErrorCode(item(), request(overrides), { policyEngine });

    expect(code).toBe(expected);
    expect(policyCalls).toBe(0);
  });

  test("keeps durable old-basis results as foldable history", async () => {
    const currentItem = item({
      completionFacts: {
        ...WorkItem.emptyCompletionFacts(),
        revision: 2,
        criteria: [criterion],
        observations: [{ ...observation(), id: "observation:history", basisRef: "basis:old" }],
        results: [
          {
            ...verifiedResult(),
            id: "result:history",
            observationIds: ["observation:history"],
            basisRef: "basis:old",
          },
        ],
      },
    });

    const admission = await resolveAdmission(
      { policyEngine: createPolicyEngine({ allowAsserted: true }), now: () => 10 },
      currentItem,
      request(),
    );

    expect(admission?.decision).toBe("admit");
    expect(admission?.effectiveResultIds).toContain("result:one");
  });

  test("rejects duplicate facts with a typed error", async () => {
    const duplicate = { ...assertedResult(), createdAt: 3 };
    const candidate = request({ results: [assertedResult(), duplicate] });

    expect(await resolveErrorCode(item(), candidate)).toBe("duplicate_fact_id");
  });

  test("reserves the generated admission id against proposed facts", async () => {
    const candidate = request({
      results: [
        {
          ...assertedResult(),
          id: "admission:wi_authority:request:completion:3",
        },
      ],
    });

    expect(await resolveErrorCode(item(), candidate)).toBe("duplicate_fact_id");
  });

  test("keeps completion authority and fold exports kernel internal", () => {
    expect(Reflect.get(WorkItemPublic, "createCompletionAuthorityResolver")).toBeUndefined();
    expect(Reflect.get(WorkItemPublic, "evaluateCompletion")).toBeUndefined();
  });

  test("keeps authority acquisition outside the pure fold", () => {
    let resolverCalls = 0;
    const foldInput = {
      admissionId: "admission:pure",
      requestId: "request:pure",
      requestSnapshot: request({ id: "request:pure" }),
      origin: "worker",
      workItemHash: "wi_authority",
      contractRevision: "contract:v1",
      basisRef: "basis:v1",
      expectedHead: 2,
      createdAt: 10,
      durableFacts: {
        ...WorkItem.emptyCompletionFacts(),
        revision: 2,
        criteria: [criterion],
      },
      proposedFacts: {
        claims: [],
        observations: [],
        results: [assertedResult()],
        invalidations: [],
        verificationErrors: [],
        effects: [],
      },
      blockers: [],
      currentAttempt: 1,
      policy: {
        policyRef: "trusted:fold-input",
        allowedAssertedCriterionIds: [],
        verdict: "allow",
        reasonCodes: [],
      },
    };
    const inputWithResolver = {
      ...foldInput,
      stakesResolver: { resolve: () => (resolverCalls += 1) },
    };

    expect(
      () => Reflect.apply(CompletionFold.evaluateCompletion, undefined, [inputWithResolver]),
      "the pure fold must return a schema-valid admission without acquiring authority",
    ).not.toThrow();
    expect(resolverCalls).toBe(0);
  });
});
