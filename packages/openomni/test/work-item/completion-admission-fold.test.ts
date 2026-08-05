import { describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import * as CompletionFold from "../../src/work-item/completion-admission-fold.js";
import type {
  CompletionCriterion,
  CompletionDurableFacts,
  CompletionEvaluationInput,
  CompletionPolicy,
  CompletionProposedFacts,
} from "../../src/work-item/completion-admission-fold.js";

const lowCriterion = {
  id: "criterion:low",
  revision: 1,
  statement: "Unit tests pass",
  required: true,
} satisfies CompletionCriterion;
const highCriterion = {
  id: "criterion:high",
  revision: 1,
  statement: "Production effect is confirmed",
  required: true,
} satisfies CompletionCriterion;

function observation(id: string, basisRef = "basis:current"): WorkItem.Observation {
  return {
    id,
    producer: "verifier:test",
    subjectRef: "wi_one",
    basisRef,
    artifactRefs: [],
    ancestryRefs: [],
    observedAt: 3,
  };
}

function result(
  id: string,
  criterionId: string,
  value: WorkItem.ResultValue,
  basisRef = "basis:current",
  createdAt = 4,
): WorkItem.CriterionResult {
  const base = {
    id,
    criterionId,
    observationIds: [`observation:${id}`],
    verifierRef: value === "asserted" ? undefined : "verifier:v1",
    assumptions: [],
    basisRef,
    createdAt,
  };
  return WorkItem.CriterionResult.parse(
    value === "asserted"
      ? { ...base, value, residualRisks: ["claimant-only evidence"] }
      : {
          ...base,
          value,
          checkedPredicate: `${criterionId} predicate`,
          residualRisks: [],
        },
  );
}

function observationFor(entry: WorkItem.CriterionResult): WorkItem.Observation {
  return observation(`observation:${entry.id}`, entry.basisRef);
}

type ProposedFacts = CompletionProposedFacts;
type ResolvedPolicy = CompletionPolicy;
type FoldInput = CompletionEvaluationInput;
type InputOptions = Partial<
  Pick<
    FoldInput,
    | "durableFacts"
    | "proposedFacts"
    | "blockers"
    | "currentAttempt"
    | "policy"
    | "stakes"
    | "ownerOverride"
  >
> &
  Readonly<{ criteria?: readonly CompletionCriterion[] }>;

function proposed(overrides: Partial<ProposedFacts> = {}): ProposedFacts {
  const results = overrides.results ?? [
    result("result:low", lowCriterion.id, "verified"),
    result("result:high", highCriterion.id, "verified"),
  ];
  return {
    claims: [],
    observations: results.map(observationFor),
    results,
    invalidations: [],
    verificationErrors: [],
    effects: [],
    ...overrides,
  };
}

const defaultPolicy = {
  policyRef: "policy:completion:v1",
  verdict: "allow",
  allowedAssertedCriterionIds: [],
  reasonCodes: [],
} satisfies ResolvedPolicy;

function input(options: InputOptions = {}): FoldInput {
  const proposedFacts = options.proposedFacts ?? proposed();
  return {
    admissionId: "admission:one",
    requestId: "request:one",
    requestSnapshot: WorkItem.CompletionRequest.parse({
      version: 1,
      id: "request:one",
      origin: "worker",
      workItemHash: "wi_one",
      contractRevision: "contract:v1",
      basisRef: "basis:current",
      expectedHead: 3,
      ...(options.ownerOverride
        ? { ownerOverrideReceiptRef: options.ownerOverride.receiptRef }
        : {}),
      ...proposedFacts,
    }),
    origin: "worker",
    workItemHash: "wi_one",
    contractRevision: "contract:v1",
    basisRef: "basis:current",
    expectedHead: 3,
    createdAt: 10,
    durableFacts: options.durableFacts ?? {
      ...WorkItem.emptyCompletionFacts(),
      revision: 3,
      criteria: [...(options.criteria ?? [lowCriterion, highCriterion])],
    },
    proposedFacts,
    blockers: options.blockers ?? [],
    currentAttempt: options.currentAttempt ?? 2,
    policy: options.policy ?? defaultPolicy,
    ...(options.stakes ? { stakes: options.stakes } : {}),
    ...(options.ownerOverride ? { ownerOverride: options.ownerOverride } : {}),
  };
}

function evaluate(foldInput: FoldInput): WorkItem.CompletionAdmission {
  return CompletionFold.evaluateCompletion(foldInput);
}

function oneCriterionFacts(
  value: WorkItem.ResultValue | "missing",
  options: Readonly<{ basisRef?: string; invalidated?: boolean; verificationError?: boolean }> = {},
): ProposedFacts {
  const results =
    value === "missing"
      ? []
      : [result("result:one", lowCriterion.id, value, options.basisRef ?? "basis:current")];
  return proposed({
    observations: results.map(observationFor),
    results,
    invalidations:
      options.invalidated && results[0]
        ? [
            {
              id: "invalidation:one",
              resultId: results[0].id,
              basisRef: "basis:current",
              reason: "superseded",
              createdAt: 5,
            },
          ]
        : [],
    verificationErrors: options.verificationError ? [verificationError(lowCriterion.id)] : [],
  });
}

function claim(criterionId: string, observationIds: readonly string[]): WorkItem.Claim {
  return {
    id: `claim:${criterionId}:${observationIds.join(":") || "none"}`,
    criterionId,
    statement: "Claim",
    observationIds: [...observationIds],
    basisRef: "basis:current",
    createdAt: 4,
  };
}

function invalidation(resultId: string): WorkItem.ResultInvalidation {
  return {
    id: `invalidation:${resultId}`,
    resultId,
    basisRef: "basis:current",
    reason: "superseded",
    createdAt: 5,
  };
}

function verificationError(
  criterionId: string,
  createdAt = 5,
  id = `verification-error:${criterionId}`,
): WorkItem.VerificationErrorFact {
  return {
    id,
    criterionId,
    code: "verifier_crash",
    detail: "deterministic verifier failure",
    verifierRef: "verifier:v1",
    basisRef: "basis:current",
    createdAt,
  };
}

describe("completion admission pure fold", () => {
  const resultCases = [
    ["verified", oneCriterionFacts("verified"), "admit", undefined],
    ["refuted", oneCriterionFacts("refuted"), "block", "required_result_refuted"],
    ["inconclusive", oneCriterionFacts("inconclusive"), "block", "required_result_inconclusive"],
    ["missing", oneCriterionFacts("missing"), "block", "required_result_missing"],
    [
      "invalidated",
      oneCriterionFacts("verified", { invalidated: true }),
      "block",
      "result_invalidated",
    ],
    [
      "basis-mismatched",
      oneCriterionFacts("verified", { basisRef: "basis:old" }),
      "block",
      "basis_mismatch",
    ],
    [
      "verification-error",
      oneCriterionFacts("verified", { verificationError: true }),
      "block",
      "verification_error",
    ],
  ] as const;
  for (const [name, facts, decision, reason] of resultCases) {
    test(`${name} required results resolve independently`, () => {
      const admission = evaluate(input({ criteria: [lowCriterion], proposedFacts: facts }));

      expect(admission.decision).toBe(decision);
      if (reason) expect(admission.reasonCodes).toContain(reason);
      if (name === "verified") {
        expect(admission).toMatchObject({ expectedHead: 3, recordedHead: 4 });
      }
    });
  }

  test("resolved policy denial blocks while retaining verified effective results", () => {
    const policy = {
      ...defaultPolicy,
      verdict: "deny",
      reasonCodes: ["work.completion_blocked"],
    } satisfies ResolvedPolicy;

    const admission = evaluate(input({ policy }));

    expect(admission.decision).toBe("block");
    expect(admission.reasonCodes).toContain("work.completion_blocked");
    expect(admission.effectiveResultIds).toEqual(["result:low", "result:high"]);
  });

  const emptyPolicyBlockCases = [
    ["deny", "policy_denied"],
    ["pending", "policy_pending"],
  ] as const;
  for (const [verdict, fallbackReason] of emptyPolicyBlockCases) {
    test(`${verdict} policy verdict blocks without supplied reasons`, () => {
      const policy = { ...defaultPolicy, verdict } satisfies ResolvedPolicy;

      const admission = evaluate(input({ policy }));

      expect(admission.decision).toBe("block");
      expect(admission.reasonCodes).toEqual([fallbackReason]);
      expect(admission.effectiveResultIds).toEqual(["result:low", "result:high"]);
    });
  }

  test("merges durable and proposed facts instead of replacing durable history", () => {
    const durableResult = result("result:low:durable", lowCriterion.id, "verified");
    const proposedResult = result("result:high:proposed", highCriterion.id, "verified");
    const durableFacts = {
      ...WorkItem.emptyCompletionFacts(),
      revision: 3,
      criteria: [lowCriterion, highCriterion],
      observations: [observationFor(durableResult)],
      results: [durableResult],
    } satisfies CompletionDurableFacts;
    const proposedFacts = proposed({
      observations: [observationFor(proposedResult)],
      results: [proposedResult],
    });

    const admission = evaluate(input({ durableFacts, proposedFacts }));

    expect(admission.decision).toBe("admit");
    expect(admission.effectiveResultIds).toEqual([durableResult.id, proposedResult.id]);
  });

  test("selects the latest current-basis non-invalidated result", () => {
    const eligible = result("result:eligible", lowCriterion.id, "verified", "basis:current", 5);
    const invalidated = result(
      "result:invalidated",
      lowCriterion.id,
      "refuted",
      "basis:current",
      7,
    );
    const stale = result("result:stale", lowCriterion.id, "refuted", "basis:old", 9);
    const proposedFacts = proposed({
      observations: [eligible, invalidated, stale].map(observationFor),
      results: [eligible, invalidated, stale],
      invalidations: [invalidation(invalidated.id)],
    });

    const admission = evaluate(input({ criteria: [lowCriterion], proposedFacts }));

    expect(admission.decision).toBe("admit");
    expect(admission.effectiveResultIds).toEqual([eligible.id]);
  });

  test("keeps an authoritative result above a later claimant assertion", () => {
    const verified = result("result:verified", lowCriterion.id, "verified", "basis:current", 5);
    const asserted = result("result:asserted", lowCriterion.id, "asserted", "basis:current", 9);
    const proposedFacts = proposed({
      observations: [verified, asserted].map(observationFor),
      results: [verified, asserted],
    });

    const admission = evaluate(input({ criteria: [lowCriterion], proposedFacts }));

    expect(admission.decision).toBe("admit");
    expect(admission.effectiveResultIds).toEqual([verified.id]);
  });

  test("breaks same-time result ties by locale-independent code-unit order", () => {
    const earlierId = result("z-result", lowCriterion.id, "verified", "basis:current", 5);
    const laterId = result("ä-result", lowCriterion.id, "refuted", "basis:current", 5);
    const proposedFacts = proposed({
      observations: [earlierId, laterId].map(observationFor),
      results: [earlierId, laterId],
    });

    const admission = evaluate(input({ criteria: [lowCriterion], proposedFacts }));

    expect(admission.decision).toBe("block");
    expect(admission.effectiveResultIds).toEqual([laterId.id]);
  });

  test("preserves an old-basis invalidation without applying it to the current fold", () => {
    const currentResult = result("result:current", lowCriterion.id, "verified");
    const oldInvalidation = {
      ...invalidation(currentResult.id),
      basisRef: "basis:old",
    } satisfies WorkItem.ResultInvalidation;
    const durableFacts = {
      ...WorkItem.emptyCompletionFacts(),
      revision: 3,
      criteria: [lowCriterion],
      observations: [observationFor(currentResult)],
      results: [currentResult],
      invalidations: [oldInvalidation],
    } satisfies CompletionDurableFacts;
    const recordedHistory = structuredClone(durableFacts);

    const admission = evaluate(
      input({ durableFacts, proposedFacts: proposed({ observations: [], results: [] }) }),
    );

    expect(admission.decision).toBe("admit");
    expect(admission.effectiveResultIds).toEqual([currentResult.id]);
    expect(admission.reasonCodes).not.toContain("result_invalidated");
    expect(durableFacts).toEqual(recordedHistory);
  });

  const verifierOutcomeCases = [
    ["later result resolves older error", 6, "result:later", "verified", 5, "error:older", false],
    ["same-time later result ID resolves error", 5, "z-result", "verified", 5, "a-error", false],
    [
      "later error supersedes verified result",
      5,
      "result:verified",
      "verified",
      6,
      "error:later",
      true,
    ],
    [
      "later error supersedes refuted result",
      5,
      "result:refuted",
      "refuted",
      6,
      "error:later",
      true,
    ],
    [
      "later error supersedes asserted result",
      5,
      "result:asserted",
      "asserted",
      6,
      "error:later",
      true,
    ],
    ["same-time later error ID supersedes result", 5, "a-result", "verified", 5, "z-error", true],
  ] as const;
  for (const [
    name,
    resultAt,
    resultId,
    value,
    errorAt,
    errorId,
    errorWins,
  ] of verifierOutcomeCases) {
    test(name, () => {
      const selected = result(resultId, lowCriterion.id, value, "basis:current", resultAt);
      const proposedFacts = proposed({
        observations: [observationFor(selected)],
        results: [selected],
        verificationErrors: [verificationError(lowCriterion.id, errorAt, errorId)],
      });
      const recordedHistory = structuredClone(proposedFacts);

      const admission = evaluate(input({ criteria: [lowCriterion], proposedFacts }));

      expect(admission.decision).toBe(errorWins ? "block" : "admit");
      expect(admission.effectiveResultIds).toEqual(errorWins ? [] : [selected.id]);
      expect(admission.unresolvedCriterionIds).toEqual(errorWins ? [lowCriterion.id] : []);
      expect(admission.reasonCodes).toEqual(errorWins ? ["verification_error"] : []);
      expect(admission.residualRisks).toEqual([]);
      expect(proposedFacts).toEqual(recordedHistory);
    });
  }

  test("effective verification error without a result does not add missing-result reasons", () => {
    const proposedFacts = proposed({
      observations: [],
      results: [],
      verificationErrors: [verificationError(lowCriterion.id)],
    });

    const admission = evaluate(input({ criteria: [lowCriterion], proposedFacts }));

    expect(admission).toMatchObject({
      decision: "block",
      effectiveResultIds: [],
      unresolvedCriterionIds: [lowCriterion.id],
      reasonCodes: ["verification_error"],
    });
  });

  test("effective verification error continues folding later criteria", () => {
    const proposedFacts = proposed({
      verificationErrors: [verificationError(lowCriterion.id)],
    });

    const admission = evaluate(input({ proposedFacts }));

    expect(admission.effectiveResultIds).toEqual(["result:high"]);
    expect(admission.unresolvedCriterionIds).toEqual([lowCriterion.id]);
    expect(admission.reasonCodes).toEqual(["verification_error"]);
  });

  const duplicateObservation = observation("fact:duplicate");
  const danglingResult = result("result:dangling", lowCriterion.id, "verified");
  const invalidGraphCases = [
    {
      name: "duplicate IDs across durable and proposed facts",
      durableFacts: { ...WorkItem.emptyCompletionFacts(), observations: [duplicateObservation] },
      facts: proposed({ observations: [duplicateObservation] }),
    },
    { name: "claim criterion", facts: proposed({ claims: [claim("criterion:missing", [])] }) },
    {
      name: "claim observation",
      facts: proposed({ claims: [claim(lowCriterion.id, ["observation:missing"])] }),
    },
    {
      name: "result criterion",
      facts: proposed({
        results: [{ ...danglingResult, criterionId: "criterion:missing" }],
        observations: [observationFor(danglingResult)],
      }),
    },
    {
      name: "result observation",
      facts: proposed({ results: [danglingResult], observations: [] }),
    },
    {
      name: "invalidation result",
      facts: proposed({ invalidations: [invalidation("result:missing")] }),
    },
    {
      name: "verification error criterion",
      facts: proposed({ verificationErrors: [verificationError("criterion:missing")] }),
    },
  ] as const;
  for (const invalidCase of invalidGraphCases) {
    test(`rejects a dangling or duplicate ${invalidCase.name}`, () => {
      const foldInput =
        "durableFacts" in invalidCase
          ? input({ durableFacts: invalidCase.durableFacts, proposedFacts: invalidCase.facts })
          : input({ proposedFacts: invalidCase.facts });

      expect(() => evaluate(foldInput)).toThrow();
    });
  }

  const assertedCases = [
    ["explicitly authorized", [lowCriterion.id], "admit"],
    ["not criterion-authorized", [], "block"],
  ] as const;
  for (const [name, allowedAssertedCriterionIds, decision] of assertedCases) {
    test(`${name} asserted result uses resolved criterion-scoped policy`, () => {
      const policy = {
        policyRef: "policy:completion:v1",
        verdict: "allow",
        allowedAssertedCriterionIds,
        reasonCodes: [],
      } satisfies ResolvedPolicy;

      const admission = evaluate(
        input({
          criteria: [lowCriterion],
          proposedFacts: oneCriterionFacts("asserted"),
          policy,
          stakes: { ref: "stakes:trusted-low", valueMilli: 1, comparison: "below" },
        }),
      );

      expect(admission.decision).toBe(decision);
      if (decision === "admit") {
        expect(admission.residualRisks).toEqual(["claimant-only evidence"]);
      }
    });
  }

  const stakesCases = [
    ["without trusted Stakes", undefined, "block"],
    [
      "with trusted Stakes",
      { ref: "stakes:trusted", valueMilli: 1_001, comparison: "above" },
      "escalate",
    ],
  ] as const;
  for (const [name, stakes, decision] of stakesCases) {
    test(`high-risk asserted result ${name}`, () => {
      const highResult = result("result:high:asserted", highCriterion.id, "asserted");
      const proposedFacts = proposed({
        observations: [observationFor(highResult)],
        results: [highResult],
      });
      const foldInput = stakes
        ? input({ criteria: [highCriterion], proposedFacts, stakes })
        : input({ criteria: [highCriterion], proposedFacts });

      expect(evaluate(foldInput).decision).toBe(decision);
    });
  }

  test("high Stakes escalates an asserted result even when policy allows that criterion", () => {
    const highResult = result("result:high:policy-allowed", highCriterion.id, "asserted");
    const proposedFacts = proposed({
      observations: [observationFor(highResult)],
      results: [highResult],
    });
    const policy = {
      ...defaultPolicy,
      allowedAssertedCriterionIds: [highCriterion.id],
    } satisfies ResolvedPolicy;

    const admission = evaluate(
      input({
        criteria: [highCriterion],
        proposedFacts,
        policy,
        stakes: {
          ref: "stakes:trusted-high",
          valueMilli: 1_001,
          comparison: "above",
        },
      }),
    );

    expect(admission.decision).toBe("escalate");
    expect(admission.reasonCodes).toContain("high_risk_asserted");
    expect(admission.reasonCodes).not.toContain("low_risk_asserted_allowed");
  });

  const blockerCases = [
    ["active", undefined, "block"],
    ["resolved", 8, "admit"],
  ] as const;
  for (const [name, resolvedAt, decision] of blockerCases) {
    test(`${name} blockers are folded`, () => {
      const blocker = {
        id: `blocker:${name}`,
        description: name,
        kind: "external",
        createdAt: 6,
        ...(resolvedAt ? { resolvedAt } : {}),
      } satisfies WorkItem.Blocker;

      const admission = evaluate(input({ blockers: [blocker] }));

      expect(admission.decision).toBe(decision);
      if (decision === "block") expect(admission.reasonCodes).toContain("active_blocker");
    });
  }

  const effectCases = [
    ["prior-attempt omitted", 1, undefined, "admit"],
    ["current-attempt omitted", 2, undefined, "block"],
    ["prior-attempt unknown", 1, "unknown", "admit"],
    ["current-attempt unknown", 2, "unknown", "block"],
    ["current-attempt confirmed", 2, "confirmed", "admit"],
    ["current-attempt failed", 2, "failed", "admit"],
  ] as const;
  for (const [name, attempt, outcome, decision] of effectCases) {
    test(`${name} effect is scoped to the current attempt`, () => {
      const proposedFacts = proposed({
        effects: [
          {
            id: `effect:${name}`,
            attempt,
            intentRef: "intent:publish",
            ...(outcome ? { outcome } : {}),
            createdAt: 6,
          },
        ],
      });

      expect(evaluate(input({ proposedFacts, currentAttempt: 2 })).decision).toBe(decision);
    });
  }

  const effectSettlementCases = [
    ["unknown then confirmed", "unknown", "confirmed", "admit"],
    ["unknown then failed", "unknown", "failed", "admit"],
    ["confirmed then unknown", "confirmed", "unknown", "block"],
  ] as const;
  for (const [name, firstOutcome, latestOutcome, decision] of effectSettlementCases) {
    test(`latest current-attempt intent settlement: ${name}`, () => {
      const proposedFacts = proposed({
        effects: [
          {
            id: `effect:${name}:first`,
            attempt: 2,
            intentRef: "intent:publish",
            outcome: firstOutcome,
            createdAt: 5,
          },
          {
            id: `effect:${name}:latest`,
            attempt: 2,
            intentRef: "intent:publish",
            outcome: latestOutcome,
            createdAt: 6,
          },
        ],
      });

      const admission = evaluate(input({ proposedFacts, currentAttempt: 2 }));

      expect(admission.decision).toBe(decision);
      expect(admission.reasonCodes.includes("effect_outcome_unresolved")).toBe(
        decision === "block",
      );
    });
  }

  test("bound Owner override keeps all blocking facts and verdicts intact", () => {
    const foldInput = input({
      criteria: [lowCriterion],
      proposedFacts: oneCriterionFacts("refuted"),
      blockers: [
        {
          id: "blocker:owner-review",
          description: "Owner accepts unresolved work",
          kind: "external",
          createdAt: 6,
        },
      ],
      ownerOverride: {
        receiptRef: "owner-receipt:one",
        workItemHash: "wi_one",
        requestId: "request:one",
        contractRevision: "contract:v1",
        basisRef: "basis:current",
      },
    });
    const recordedFacts = structuredClone(foldInput.proposedFacts);

    const admission = evaluate(foldInput);

    expect(admission).toMatchObject({
      decision: "owner_override",
      ownerOverrideReceiptRef: "owner-receipt:one",
      effectiveResultIds: ["result:one"],
      unresolvedCriterionIds: [lowCriterion.id],
    });
    expect(admission.reasonCodes).toContain("active_blocker");
    expect(foldInput.proposedFacts).toEqual(recordedFacts);
  });

  test("bound Owner override escapes a recorded policy denial without changing results", () => {
    const foldInput = input({
      policy: {
        ...defaultPolicy,
        verdict: "deny",
        reasonCodes: ["work.completion_blocked"],
      },
      ownerOverride: {
        receiptRef: "owner-receipt:policy-denial",
        workItemHash: "wi_one",
        requestId: "request:one",
        contractRevision: "contract:v1",
        basisRef: "basis:current",
      },
    });
    const recordedResults = structuredClone(foldInput.proposedFacts.results);

    const admission = evaluate(foldInput);

    expect(admission.decision).toBe("owner_override");
    expect(admission.reasonCodes).toContain("work.completion_blocked");
    expect(admission.effectiveResultIds).toEqual(["result:low", "result:high"]);
    expect(foldInput.proposedFacts.results).toEqual(recordedResults);
  });

  test("rejects an Owner override receipt bound to another contract revision", () => {
    const foldInput = input({
      ownerOverride: {
        receiptRef: "owner-receipt:wrong-contract",
        workItemHash: "wi_one",
        requestId: "request:one",
        contractRevision: "contract:other",
        basisRef: "basis:current",
      },
    });
    let failure: unknown;

    try {
      evaluate(foldInput);
    } catch (error) {
      if (error instanceof Error) failure = error;
      else throw error;
    }

    expect(failure).toMatchObject({
      name: "CompletionFoldError",
      code: "invalid_owner_override_binding",
      factId: "owner-receipt:wrong-contract",
    });
  });

  test("has a deterministic dependency-free module surface", async () => {
    const source = await Bun.file(
      new URL("../../src/work-item/completion-admission-fold.ts", import.meta.url),
    ).text();
    const imports = new Bun.Transpiler({ loader: "ts" }).scan(source).imports;
    const foldInput = input();
    const before = structuredClone(foldInput);

    const first = evaluate(foldInput);
    const second = evaluate(foldInput);

    expect(Object.keys(CompletionFold)).toEqual(["evaluateCompletion"]);
    expect(imports.map((entry) => entry.path)).toEqual(["@openomni/protocol"]);
    expect(second).toEqual(first);
    expect(foldInput).toEqual(before);
  });
});
