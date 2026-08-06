import { describe, expect, test } from "bun:test";
import { WorkItem } from "./index.js";
import { validateTerminalLinkage } from "./terminal-linkage.js";

const baseItem = {
  hash: "wi_admission",
  name: "Admission contract",
  sourceMessageId: "msg_admission",
  sourceChannel: "test",
  attempt: 1,
  timestamps: { created: 1, updated: 1 },
  relations: { childHashes: [], dependsOn: [] },
  intent: "complete",
  goal: "close only after admission",
  constraints: [],
  acceptanceCriteria: ["publish the artifact"],
  changedFiles: [],
  blockers: [],
  evidence: [],
};

function completionRequestSnapshot(overrides: Readonly<Record<string, unknown>> = {}) {
  return WorkItem.CompletionRequest.parse({
    version: 1,
    id: "completion-request:one",
    origin: "worker",
    workItemHash: baseItem.hash,
    contractRevision: "contract:v1",
    basisRef: "basis:v1",
    expectedHead: 3,
    claims: [],
    observations: [],
    results: [],
    invalidations: [],
    verificationErrors: [],
    effects: [],
    ...overrides,
  });
}

describe("WorkItem completion admission contracts", () => {
  test("rejects duplicate fact ids across request-local arrays", () => {
    const duplicateId = "fact:request-local-duplicate";
    expect(
      WorkItem.CompletionRequest.safeParse({
        ...completionRequestSnapshot(),
        claims: [
          {
            id: duplicateId,
            criterionId: "criterion:one",
            statement: "the claim and observation ids must not collide",
            observationIds: [],
            basisRef: "basis:v1",
            createdAt: 1,
          },
        ],
        observations: [
          {
            id: duplicateId,
            producer: "verifier:test",
            subjectRef: baseItem.hash,
            basisRef: "basis:v1",
            artifactRefs: [],
            ancestryRefs: [],
            observedAt: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("distinguishes legacy reservations from held leases", () => {
    const base = {
      version: 1,
      id: "reservation:one",
      requestId: "request:one",
      requestRoot: "request-root:one",
      envelopeDigest: "digest:one",
      expectedHead: 0,
      recordedHead: 1,
      createdAt: 100,
    };

    expect(WorkItem.CompletionRequestReservation.parse(base)).toMatchObject({
      fence: 0,
    });
    expect(
      WorkItem.CompletionRequestReservation.parse({
        ...base,
        ownerId: "process:one",
        fence: 1,
        leaseExpiresAt: 110,
      }),
    ).toMatchObject({
      ownerId: "process:one",
      fence: 1,
      leaseExpiresAt: 110,
    });
    expect(
      WorkItem.CompletionRequestReservation.parse({
        ...base,
        ownerId: "process:recovery",
        fence: 2,
        leaseExpiresAt: base.createdAt,
      }),
    ).toMatchObject({
      ownerId: "process:recovery",
      fence: 2,
      leaseExpiresAt: base.createdAt,
    });
    const reservation = WorkItem.CompletionRequestReservation.parse({
      ...base,
      ownerId: "process:collision",
      fence: 3,
      leaseExpiresAt: 120,
    });
    expect(
      WorkItem.CompletionFacts.safeParse({
        ...WorkItem.emptyCompletionFacts(),
        criteria: [
          {
            id: reservation.id,
            revision: 1,
            statement: "reservation ids remain globally unique",
            required: true,
          },
        ],
        requestReservations: [reservation],
      }).success,
    ).toBe(false);
  });

  test("binds qualified source identity kind to completion origin", () => {
    const request = completionRequestSnapshot();

    expect(
      WorkItem.CompletionRequest.safeParse({
        ...request,
        origin: "resident",
        sourceIdentity: {
          source: "sdk",
          identity: { kind: "worker", id: "worker:forged" },
        },
      }).success,
    ).toBe(false);
    expect(
      WorkItem.CompletionRequest.safeParse({
        ...request,
        origin: "worker",
        sourceIdentity: {
          source: "sdk",
          identity: { kind: "worker", id: "worker:assigned" },
        },
      }).success,
    ).toBe(true);
    expect(
      WorkItem.CompletionRequest.safeParse({
        ...request,
        origin: "replay",
        sourceIdentity: {
          source: "replay",
          identity: { kind: "worker", id: "worker:assigned" },
        },
      }).success,
    ).toBe(true);
    expect(
      WorkItem.CompletionRequest.safeParse({
        ...request,
        origin: "recovery",
        sourceIdentity: {
          source: "replay",
          identity: { kind: "worker", id: "worker:assigned" },
        },
      }).success,
    ).toBe(false);
    for (const [source, origin] of [
      ["internal_worker", "worker"],
      ["connector_worker", "worker"],
      ["replay", "replay"],
      ["recovery", "recovery"],
    ] as const) {
      expect(
        WorkItem.CompletionRequest.safeParse({
          ...request,
          origin,
          sourceIdentity: {
            source,
            identity: { kind: "worker", id: "worker:assigned" },
          },
        }).success,
      ).toBe(true);
      expect(
        WorkItem.CompletionRequest.safeParse({
          ...request,
          origin: "resident",
          sourceIdentity: {
            source,
            identity: { kind: "resident", id: "resident:forged" },
          },
        }).success,
      ).toBe(false);
      expect(
        WorkItem.CompletionRequest.safeParse({
          ...request,
          origin,
          sourceIdentity: {
            source,
            identity: { kind: "external_actor", id: "actor:forged" },
          },
        }).success,
      ).toBe(false);
    }
  });

  test("keeps criteria, claims, observations, results, and invalidations distinct", () => {
    const completionFacts = WorkItem.CompletionFacts.parse({
      version: 1,
      revision: 4,
      criteria: [
        {
          id: "criterion:publish",
          revision: 1,
          statement: "Publish the artifact",
          required: true,
        },
      ],
      claims: [
        {
          id: "claim:publish",
          criterionId: "criterion:publish",
          statement: "The artifact was published",
          observationIds: ["observation:publish"],
          basisRef: "basis:v1",
          createdAt: 2,
        },
      ],
      observations: [
        {
          id: "observation:publish",
          producer: "worker:one",
          subjectRef: "artifact:one",
          basisRef: "basis:v1",
          artifactRefs: ["artifact:one"],
          provenanceRef: "run:one",
          ancestryRefs: [],
          observedAt: 3,
        },
      ],
      results: [
        {
          id: "result:publish",
          criterionId: "criterion:publish",
          value: "verified",
          checkedPredicate: "artifact is published",
          observationIds: ["observation:publish"],
          verifierRef: "verifier:registry:v1",
          assumptions: [],
          basisRef: "basis:v1",
          residualRisks: [],
          createdAt: 4,
        },
      ],
      invalidations: [
        {
          id: "invalidation:old",
          resultId: "result:old",
          basisRef: "basis:v1",
          reason: "superseded observation",
          createdAt: 5,
        },
      ],
      verificationErrors: [
        {
          id: "verification-error:publish",
          criterionId: "criterion:publish",
          code: "verifier_crash",
          detail: "Verifier process exited before producing a result",
          verifierRef: "verifier:registry:v1",
          basisRef: "basis:v1",
          createdAt: 5,
        },
      ],
      effects: [
        {
          id: "effect:publish",
          attempt: 1,
          intentRef: "intent:publish",
          outcome: "confirmed",
          createdAt: 6,
        },
      ],
      admissions: [],
    });

    expect(completionFacts.criteria[0]?.id).toBe("criterion:publish");
    expect(completionFacts.claims[0]?.observationIds).toEqual(["observation:publish"]);
    expect(completionFacts.results[0]?.value).toBe("verified");
    expect(completionFacts.invalidations[0]?.resultId).toBe("result:old");
    expect(completionFacts.verificationErrors[0]?.code).toBe("verifier_crash");
    expect(completionFacts.effects[0]?.outcome).toBe("confirmed");
  });

  test("derives stable criterion IDs from WorkItem, index, and statement", () => {
    const first = WorkItem.criterionId("wi_criterion", 0, "publish artifact");

    expect(WorkItem.criterionId("wi_criterion", 0, "publish artifact")).toBe(first);
    expect(WorkItem.criterionId("wi_criterion", 0, "publish another artifact")).not.toBe(first);
  });

  test("parses an outcome-less effect intent without inventing an outcome", () => {
    const input = {
      id: "effect:pending",
      attempt: 1,
      intentRef: "intent:pending",
      createdAt: 6,
    };

    const effect = WorkItem.EffectRecord.parse(input);

    expect(effect).toEqual(input);
    expect("outcome" in effect).toBe(false);
  });

  test("parses verification errors as deterministic machine-consumable facts", () => {
    const input = {
      id: "verification-error:publish",
      criterionId: "criterion:publish",
      code: "malformed_output",
      detail: "Verifier output did not match its declared schema",
      verifierRef: "verifier:registry:v1",
      basisRef: "basis:v1",
      createdAt: 5,
    } as const;

    const firstRead = WorkItem.VerificationErrorFact.parse(input);
    const repeatedRead = WorkItem.VerificationErrorFact.parse(input);

    expect(repeatedRead).toEqual(firstRead);
    expect(firstRead).toEqual(input);
    expect(WorkItem.emptyCompletionFacts().verificationErrors).toEqual([]);
  });

  test("rejects a raw legacy row at the public WorkItem.Info boundary", () => {
    expect(WorkItem.Info.safeParse(baseItem).success).toBe(false);
  });

  test("upcasts a fully evidenced completed legacy WorkItem with truthful admission linkage", () => {
    const legacyItem = {
      ...baseItem,
      timestamps: { ...baseItem.timestamps, completed: 8 },
      evidence: [
        {
          id: "evidence:legacy-publish",
          kind: "verification",
          description: "Legacy publication check passed",
          passed: true,
          detail: "generated while decoding a completed legacy row without a completion report",
          createdAt: 6,
        },
      ],
      completionReport: {
        summary: "Published the artifact.",
        claims: [
          {
            statement: "publish the artifact",
            evidenceIds: ["evidence:legacy-publish"],
          },
        ],
        caveats: [],
        followUps: [],
      },
    };

    const item = WorkItem.Info.parse(WorkItem.upcastLegacyCompletion(legacyItem));
    const admission = item.completionFacts.admissions[0];

    expect(item.completionFacts.results).toEqual([
      expect.objectContaining({
        criterionId: WorkItem.criterionId(legacyItem.hash, 0, "publish the artifact"),
        value: "asserted",
        assumptions: ["legacy passed evidence was claimant-supplied"],
      }),
    ]);
    expect(admission).toMatchObject({
      decision: "admit",
      unresolvedCriterionIds: [],
      effectiveResultIds: item.completionFacts.results.map(({ id }) => id),
    });
    expect(item.completionTerminalReceipt).toMatchObject({
      admissionId: admission?.id,
      requestId: admission?.requestId,
      recordedHead: 2,
    });
  });

  test("archives a completed legacy WorkItem without a persisted report", () => {
    const occupiedArchiveEvidenceId = `evidence:${baseItem.hash}:legacy-completion-archive`;
    const legacyItem = {
      ...baseItem,
      timestamps: { ...baseItem.timestamps, completed: 8 },
      evidence: [
        {
          id: occupiedArchiveEvidenceId,
          kind: "custom",
          description: "pre-existing legacy evidence",
          passed: false,
          createdAt: 7,
        },
      ],
    };

    const item = WorkItem.Info.parse(WorkItem.upcastLegacyCompletion(legacyItem));
    const archiveEvidenceId = `${occupiedArchiveEvidenceId}:1`;
    const admission = item.completionFacts.admissions[0];

    expect(item.evidence).toContainEqual(
      expect.objectContaining({
        id: archiveEvidenceId,
        kind: "custom",
        passed: true,
      }),
    );
    expect(item.completionReport).toEqual({
      summary: "Archived historical completion without a persisted report.",
      claims: [
        {
          statement: "publish the artifact",
          evidenceIds: [archiveEvidenceId],
        },
      ],
      caveats: ["the historical completion report was not persisted"],
      followUps: [],
    });
    expect(item.completionTerminalReceipt).toMatchObject({
      admissionId: admission?.id,
      completionReportRef: admission?.completionReportRef,
      recordedHead: 2,
    });
    expect(item.completionFacts.results[0]?.assumptions).toContain(
      "archive evidence was generated while decoding historical completion",
    );
  });

  test.each([
    ["missing", [], "legacy report claim evidence is missing: evidence:legacy-failed"],
    [
      "failed",
      [
        {
          id: "evidence:legacy-failed",
          kind: "verification",
          description: "Legacy publication check failed",
          passed: false,
          createdAt: 6,
        },
      ],
      `completed legacy WorkItem lacks passed evidence for report claims: ${WorkItem.criterionId(
        baseItem.hash,
        0,
        "publish the artifact",
      )}`,
    ],
  ])("rejects a completed legacy WorkItem with %s required evidence", (_kind, evidence, expectedError) => {
    const legacyItem = {
      ...baseItem,
      timestamps: { ...baseItem.timestamps, completed: 8 },
      evidence,
      completionReport: {
        summary: "Legacy publication report.",
        claims: [
          {
            statement: "publish the artifact",
            evidenceIds: ["evidence:legacy-failed"],
          },
        ],
        caveats: [],
        followUps: [],
      },
    };

    expect(() => WorkItem.upcastLegacyCompletion(legacyItem)).toThrow(expectedError);
  });

  test("rejects completed legacy claims with mixed present and missing evidence", () => {
    const legacyItem = {
      ...baseItem,
      timestamps: { ...baseItem.timestamps, completed: 8 },
      evidence: [
        {
          id: "evidence:legacy-present",
          kind: "verification",
          description: "Legacy publication check passed",
          passed: true,
          createdAt: 6,
        },
      ],
      completionReport: {
        summary: "Legacy publication report.",
        claims: [
          {
            statement: "publish the artifact",
            evidenceIds: ["evidence:legacy-present", "evidence:legacy-missing"],
          },
        ],
        caveats: [],
        followUps: [],
      },
    };

    expect(() => WorkItem.upcastLegacyCompletion(legacyItem)).toThrow(
      "legacy report claim evidence is missing: evidence:legacy-missing",
    );
  });

  test("rejects duplicate legacy evidence identities before archive admission", () => {
    const duplicateEvidence = {
      ...baseItem,
      timestamps: { ...baseItem.timestamps, completed: 8 },
      evidence: [
        {
          id: "evidence:legacy-duplicate",
          kind: "verification",
          description: "Legacy publication check passed",
          passed: true,
          createdAt: 6,
        },
        {
          id: "evidence:legacy-duplicate",
          kind: "verification",
          description: "Legacy publication check failed",
          passed: false,
          createdAt: 7,
        },
      ],
      completionReport: {
        summary: "Duplicate legacy evidence.",
        claims: [
          {
            statement: "publish the artifact",
            evidenceIds: ["evidence:legacy-duplicate"],
          },
        ],
        caveats: [],
        followUps: [],
      },
    };

    expect(() => WorkItem.upcastLegacyCompletion(duplicateEvidence)).toThrow(
      "duplicate legacy evidence id: evidence:legacy-duplicate",
    );
  });

  test("archives completed legacy paraphrases as explicit unresolved overrides", () => {
    const legacyItem = {
      ...baseItem,
      acceptanceCriteria: ["publish artifact"],
      timestamps: { ...baseItem.timestamps, completed: 8 },
      evidence: [
        {
          id: "evidence:legacy-paraphrase",
          kind: "verification",
          description: "Legacy publication check passed",
          passed: true,
          createdAt: 6,
        },
      ],
      completionReport: {
        summary: "Legacy publication report.",
        claims: [
          {
            statement: "The artifact was published",
            evidenceIds: ["evidence:legacy-paraphrase"],
          },
        ],
        caveats: [],
        followUps: [],
      },
    };

    const item = WorkItem.Info.parse(WorkItem.upcastLegacyCompletion(legacyItem));
    expect(WorkItem.deriveStatus(item)).toBe("completed");
    expect(item.completionFacts.admissions[0]).toMatchObject({
      reasonCodes: ["legacy_archive_override"],
      unresolvedCriterionIds: [],
    });
    expect(item.completionFacts.results).toContainEqual(
      expect.objectContaining({
        criterionId: WorkItem.criterionId(legacyItem.hash, 0, "publish artifact"),
        value: "asserted",
      }),
    );
  });

  test("archives historically valid whitespace-only legacy claim statements", () => {
    const legacyItem = {
      ...baseItem,
      timestamps: { ...baseItem.timestamps, completed: 8 },
      evidence: [
        {
          id: "evidence:legacy-publish",
          kind: "verification",
          description: "Legacy publication check passed",
          passed: true,
          createdAt: 6,
        },
      ],
      completionReport: {
        summary: "Legacy report contains a whitespace claim.",
        claims: [{ statement: "   ", evidenceIds: ["evidence:legacy-publish"] }],
        caveats: [],
        followUps: [],
      },
    };

    const item = WorkItem.Info.parse(WorkItem.upcastLegacyCompletion(legacyItem));
    expect(WorkItem.deriveStatus(item)).toBe("completed");
    expect(item.completionReport?.claims[0]?.statement).toBe('Legacy archived claim 1: "   "');
  });

  test("retains legacy report claims beyond the original acceptance criteria", () => {
    const legacyItem = {
      ...baseItem,
      evidence: [
        {
          id: "evidence:legacy-primary",
          kind: "verification",
          description: "Primary claim evidence",
          passed: true,
          createdAt: 6,
        },
        {
          id: "evidence:legacy-extra",
          kind: "verification",
          description: "Extra claim evidence",
          passed: true,
          createdAt: 7,
        },
      ],
      completionReport: {
        summary: "Both historical claims were reported.",
        claims: [
          {
            statement: "The artifact was published",
            evidenceIds: ["evidence:legacy-primary"],
          },
          {
            statement: "The release index was refreshed",
            evidenceIds: ["evidence:legacy-extra"],
          },
        ],
        caveats: [],
        followUps: [],
      },
    };

    const firstRead = WorkItem.Info.parse(WorkItem.upcastLegacyCompletion(legacyItem));
    const repeatedRead = WorkItem.Info.parse(WorkItem.upcastLegacyCompletion(legacyItem));

    expect(firstRead.acceptanceCriteria).toEqual([
      "publish the artifact",
      "The artifact was published",
      "The release index was refreshed",
    ]);
    expect(firstRead.completionFacts.criteria.map(({ statement }) => statement)).toEqual(
      firstRead.acceptanceCriteria,
    );
    expect(firstRead.completionFacts.claims.map(({ statement }) => statement)).toEqual([
      "The artifact was published",
      "The release index was refreshed",
    ]);
    expect(firstRead.completionFacts.claims.map(({ criterionId }) => criterionId)).toEqual([
      WorkItem.criterionId(legacyItem.hash, 1, "The artifact was published"),
      WorkItem.criterionId(legacyItem.hash, 2, "The release index was refreshed"),
    ]);
    expect(repeatedRead.completionFacts).toEqual(firstRead.completionFacts);
  });

  test("matches legacy report claims by exact statement rather than report position", () => {
    const legacyItem = {
      ...baseItem,
      acceptanceCriteria: ["first historical criterion", "second historical criterion"],
      evidence: [
        {
          id: "evidence:legacy-second",
          kind: "verification",
          description: "Second criterion evidence",
          passed: true,
          createdAt: 6,
        },
        {
          id: "evidence:legacy-reworded",
          kind: "verification",
          description: "Reworded claim evidence",
          passed: true,
          createdAt: 7,
        },
        {
          id: "evidence:legacy-first",
          kind: "verification",
          description: "First criterion evidence",
          passed: false,
          createdAt: 8,
        },
      ],
      completionReport: {
        summary: "Historical claims were reported in another order.",
        claims: [
          { statement: "second historical criterion", evidenceIds: ["evidence:legacy-second"] },
          { statement: "reworded historical claim", evidenceIds: ["evidence:legacy-reworded"] },
          { statement: "first historical criterion", evidenceIds: ["evidence:legacy-first"] },
        ],
        caveats: [],
        followUps: [],
      },
    };

    const item = WorkItem.Info.parse(WorkItem.upcastLegacyCompletion(legacyItem));

    expect(item.acceptanceCriteria).toEqual([
      "first historical criterion",
      "second historical criterion",
      "reworded historical claim",
    ]);
    expect(item.completionFacts.claims.map(({ criterionId }) => criterionId)).toEqual([
      WorkItem.criterionId(legacyItem.hash, 1, "second historical criterion"),
      WorkItem.criterionId(legacyItem.hash, 2, "reworded historical claim"),
      WorkItem.criterionId(legacyItem.hash, 0, "first historical criterion"),
    ]);
    expect(item.completionFacts.claims.map(({ statement }) => statement)).toEqual(
      legacyItem.completionReport.claims.map(({ statement }) => statement),
    );
    expect(item.completionFacts.results.map(({ value }) => value)).toEqual([
      "asserted",
      "asserted",
    ]);
  });

  test("preserves failed legacy evidence without synthesizing a decisive result", () => {
    const item = WorkItem.Info.parse(
      WorkItem.upcastLegacyCompletion({
        ...baseItem,
        evidence: [
          {
            id: "evidence:legacy-pass",
            kind: "verification",
            description: "One linked check passed",
            passed: true,
            createdAt: 6,
          },
          {
            id: "evidence:legacy-fail",
            kind: "verification",
            description: "One linked check failed",
            passed: false,
            createdAt: 7,
          },
        ],
        completionReport: {
          summary: "Legacy completion with mixed evidence",
          claims: [
            {
              statement: "The artifact was published",
              evidenceIds: ["evidence:legacy-pass", "evidence:legacy-fail"],
            },
          ],
          caveats: [],
          followUps: [],
        },
      }),
    );

    expect(item.completionFacts.results).toEqual([]);
    expect(item.evidence.map(({ passed }) => passed)).toEqual([true, false]);
  });

  test("enforces terminal receipt linkage to its completion head and admission", () => {
    const completionReport = {
      summary: "Completed through terminal linkage.",
      claims: [
        {
          statement: "publish the artifact",
          evidenceIds: ["evidence:terminal"],
        },
      ],
      caveats: [],
      followUps: [],
    };
    const completionReportRef =
      "sha256:5385886237aaad18a0e18c9ef931a7cddc9d1d06a4fbe4203df6fcf4839efa05";
    const completionContract = {
      version: 1 as const,
      revision: "contract:v1",
      basisRef: "basis:v1",
    };
    const terminalCriterionId = WorkItem.criterionId(baseItem.hash, 0, "publish the artifact");
    const terminalObservation = WorkItem.Observation.parse({
      id: "observation:terminal",
      producer: "verifier:terminal",
      subjectRef: baseItem.hash,
      basisRef: completionContract.basisRef,
      artifactRefs: ["evidence:terminal"],
      provenanceRef: "evidence:terminal",
      ancestryRefs: [],
      observedAt: 6,
    });
    const terminalClaim = WorkItem.Claim.parse({
      id: "claim:terminal",
      criterionId: terminalCriterionId,
      statement: "publish the artifact",
      observationIds: [terminalObservation.id],
      basisRef: completionContract.basisRef,
      createdAt: 6,
    });
    const terminalResult = WorkItem.CriterionResult.parse({
      id: "result:terminal",
      criterionId: terminalCriterionId,
      observationIds: [terminalObservation.id],
      value: "asserted",
      assumptions: [],
      residualRisks: [],
      basisRef: completionContract.basisRef,
      createdAt: 6,
    });
    const admission = WorkItem.CompletionAdmission.parse({
      version: 1,
      id: "admission:terminal",
      requestId: "completion-request:terminal",
      requestSnapshot: completionRequestSnapshot({
        id: "completion-request:terminal",
        expectedHead: 0,
        claims: [terminalClaim],
        observations: [terminalObservation],
        results: [terminalResult],
      }),
      origin: "worker",
      contractRevision: completionContract.revision,
      basisRef: completionContract.basisRef,
      effectiveResultIds: [terminalResult.id],
      unresolvedCriterionIds: [],
      decision: "admit",
      reasonCodes: [],
      residualRisks: [],
      policyRef: "policy:terminal",
      completionReportSnapshot: completionReport,
      completionReportRef,
      expectedHead: 0,
      recordedHead: 1,
      createdAt: 7,
    });
    const completionFacts = {
      ...WorkItem.emptyCompletionFacts(),
      revision: 1,
      criteria: [
        {
          id: terminalCriterionId,
          revision: 1,
          statement: "publish the artifact",
          required: true,
        },
      ],
      claims: [terminalClaim],
      observations: [terminalObservation],
      results: [terminalResult],
      admissions: [admission],
    };
    const completionTerminalReceipt = {
      version: 1 as const,
      hash: baseItem.hash,
      requestId: admission.requestId,
      admissionId: admission.id,
      contractRevision: completionContract.revision,
      basisRef: completionContract.basisRef,
      completionReportRef,
      recordedHead: 2,
    };
    const validInput = {
      ...baseItem,
      revision: 2,
      timestamps: { ...baseItem.timestamps, completed: 8 },
      evidence: [
        {
          id: "evidence:terminal",
          kind: "verification" as const,
          description: "Terminal publication evidence",
          passed: true,
          attempt: baseItem.attempt,
          basisRef: completionContract.basisRef,
          createdAt: 6,
        },
      ],
      completionContract,
      completionFacts,
      completionReport,
      completionTerminalReceipt,
    };
    const ownerRefutedResult = WorkItem.CriterionResult.parse({
      ...terminalResult,
      id: "result:terminal-owner-refuted",
      value: "refuted",
      checkedPredicate: "Owner accepted the known verification failure",
    });
    const ownerUnresolvedCriterion = {
      id: WorkItem.criterionId(baseItem.hash, 1, "accept the residual risk"),
      revision: 1,
      statement: "accept the residual risk",
      required: true,
    };
    const ownerAdmission = WorkItem.CompletionAdmission.parse({
      ...admission,
      id: "admission:owner-override",
      decision: "owner_override",
      effectiveResultIds: [ownerRefutedResult.id],
      unresolvedCriterionIds: [ownerUnresolvedCriterion.id],
      ownerOverrideReceiptRef: "owner-receipt:terminal",
      requestSnapshot: {
        ...admission.requestSnapshot,
        ownerOverrideReceiptRef: "owner-receipt:terminal",
      },
    });
    const ownerOverrideInput = {
      ...validInput,
      acceptanceCriteria: [...validInput.acceptanceCriteria, ownerUnresolvedCriterion.statement],
      completionFacts: {
        ...completionFacts,
        criteria: [...completionFacts.criteria, ownerUnresolvedCriterion],
        results: [ownerRefutedResult],
        admissions: [ownerAdmission],
      },
      completionTerminalReceipt: {
        ...completionTerminalReceipt,
        admissionId: ownerAdmission.id,
      },
    };
    const reservationBridge = (id: string) =>
      WorkItem.CompletionRequestReservation.parse({
        version: 1,
        id,
        requestId: admission.requestId,
        requestRoot: "request-root:terminal",
        envelopeDigest: "envelope-digest:terminal",
        expectedHead: admission.recordedHead,
        recordedHead: admission.recordedHead + 1,
        createdAt: 7,
        ownerId: "process:terminal",
        fence: 1,
        leaseExpiresAt: 20,
      });
    const invalidInputs = [
      {
        ...validInput,
        revision: validInput.revision + 1,
        completionFacts: {
          ...completionFacts,
          requestReservations: [
            reservationBridge("reservation:terminal:first"),
            reservationBridge("reservation:terminal:second"),
          ],
        },
        completionTerminalReceipt: {
          ...completionTerminalReceipt,
          recordedHead: completionTerminalReceipt.recordedHead + 1,
        },
      },
      {
        ...validInput,
        completionFacts: {
          ...completionFacts,
          results: [],
          admissions: [{ ...admission, effectiveResultIds: [] }],
        },
      },
      {
        ...validInput,
        completionFacts: {
          ...completionFacts,
          admissions: [
            {
              ...admission,
              decision: "owner_override",
              unresolvedCriterionIds: ["criterion:missing"],
              ownerOverrideReceiptRef: "owner-receipt:terminal",
              requestSnapshot: {
                ...admission.requestSnapshot,
                ownerOverrideReceiptRef: "owner-receipt:terminal",
              },
            },
          ],
        },
      },
      { ...validInput, completionTerminalReceipt: undefined },
      { ...validInput, timestamps: { created: 1, updated: 8 } },
      {
        ...validInput,
        completionTerminalReceipt: { ...completionTerminalReceipt, hash: "wi_other" },
      },
      {
        ...validInput,
        completionTerminalReceipt: {
          ...completionTerminalReceipt,
          contractRevision: "contract:other",
        },
      },
      {
        ...validInput,
        completionTerminalReceipt: { ...completionTerminalReceipt, basisRef: "basis:other" },
      },
      {
        ...validInput,
        completionTerminalReceipt: { ...completionTerminalReceipt, recordedHead: 3 },
      },
      { ...validInput, completionFacts: { ...completionFacts, admissions: [] } },
      {
        ...validInput,
        completionFacts: {
          ...completionFacts,
          admissions: [{ ...admission, decision: "block" }],
        },
      },
      {
        ...validInput,
        completionFacts: {
          ...completionFacts,
          admissions: [{ ...admission, requestId: "completion-request:other" }],
        },
      },
      {
        ...validInput,
        completionFacts: {
          ...completionFacts,
          admissions: [
            {
              ...admission,
              requestSnapshot: { ...admission.requestSnapshot, workItemHash: "wi_other" },
            },
          ],
        },
      },
      {
        ...validInput,
        completionFacts: {
          ...completionFacts,
          admissions: [{ ...admission, contractRevision: "contract:other" }],
        },
      },
      {
        ...validInput,
        completionFacts: {
          ...completionFacts,
          admissions: [{ ...admission, basisRef: "basis:other" }],
        },
      },
      {
        ...validInput,
        completionFacts: {
          ...completionFacts,
          admissions: [{ ...admission, expectedHead: 1, recordedHead: 2 }],
        },
      },
      {
        ...validInput,
        completionFacts: {
          ...completionFacts,
          admissions: [
            {
              ...admission,
              completionReportRef:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        },
        completionTerminalReceipt: {
          ...completionTerminalReceipt,
          completionReportRef:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      },
      {
        ...validInput,
        completionReport: undefined,
        completionFacts: {
          ...completionFacts,
          admissions: [
            {
              ...admission,
              completionReportSnapshot: undefined,
              completionReportRef: undefined,
            },
          ],
        },
        completionTerminalReceipt: {
          ...completionTerminalReceipt,
          completionReportRef: undefined,
        },
      },
    ];

    expect(WorkItem.Info.safeParse(validInput).success).toBe(true);
    expect(WorkItem.Info.safeParse(ownerOverrideInput).success).toBe(true);
    expect(
      WorkItem.Info.safeParse({ ...validInput, revision: 3, outcome: "adopted" }).success,
    ).toBe(true);
    expect(invalidInputs.map((input) => WorkItem.Info.safeParse(input).success)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    const unresolvedAdmission = WorkItem.Info.safeParse({
      ...validInput,
      completionFacts: {
        ...completionFacts,
        admissions: [{ ...admission, unresolvedCriterionIds: ["criterion:missing"] }],
      },
    });
    expect(unresolvedAdmission.success).toBe(false);
    if (!unresolvedAdmission.success) {
      expect(unresolvedAdmission.error.issues.map(({ path }) => path)).toContainEqual([
        "completionFacts",
        "admissions",
        0,
        "unresolvedCriterionIds",
      ]);
    }
    const missingTerminalEvidence = WorkItem.Info.safeParse({
      ...validInput,
      evidence: [],
    });
    expect(missingTerminalEvidence.success).toBe(false);
    if (!missingTerminalEvidence.success) {
      expect(missingTerminalEvidence.error.issues.map(({ path }) => path)).toContainEqual([
        "completionReport",
        "claims",
        0,
        "evidenceIds",
        0,
      ]);
    }
    const terminalEvidence = validInput.evidence[0];
    if (!terminalEvidence) throw new Error("terminal evidence fixture is missing");
    for (const evidence of [
      [{ ...terminalEvidence, passed: false }, terminalEvidence],
      [terminalEvidence, { ...terminalEvidence, passed: false }],
    ]) {
      const duplicateTerminalEvidence = WorkItem.Info.safeParse({
        ...validInput,
        evidence,
      });
      expect(duplicateTerminalEvidence.success).toBe(false);
      if (!duplicateTerminalEvidence.success) {
        expect(duplicateTerminalEvidence.error.issues.map(({ path }) => path)).toContainEqual([
          "evidence",
          1,
          "id",
        ]);
      }
    }
    for (const [field, value] of [
      ["subjectRef", "wi_other"],
      ["basisRef", "basis:other"],
    ] as const) {
      const foreignObservation = WorkItem.Info.safeParse({
        ...validInput,
        completionFacts: {
          ...completionFacts,
          observations: [{ ...terminalObservation, [field]: value }],
        },
      });
      expect(foreignObservation.success).toBe(false);
      if (!foreignObservation.success) {
        expect(foreignObservation.error.issues.map(({ path }) => path)).toContainEqual([
          "completionFacts",
          "observations",
          0,
          field,
        ]);
      }
    }
  });

  test("preserves the explicit legacy upcast above the former boundary", () => {
    const oversized = {
      ...baseItem,
      acceptanceCriteria: Array.from({ length: 257 }, (_, index) => `criterion ${index}`),
    };

    expect(WorkItem.Info.safeParse(WorkItem.upcastLegacyCompletion(oversized)).success).toBe(true);
  });

  test("upcasts historically valid blank legacy goals and acceptance criteria", () => {
    const item = WorkItem.Info.parse(
      WorkItem.upcastLegacyCompletion({
        ...baseItem,
        goal: "",
        acceptanceCriteria: ["", "   "],
      }),
    );

    expect(item.goal).toBe("");
    expect(item.acceptanceCriteria).toEqual([baseItem.name]);
    expect(item.completionFacts.criteria).toHaveLength(1);
    expect(item.completionFacts.criteria[0]?.statement).toBe(baseItem.name);
  });

  test("upcasts the historical acceptance-criteria boundary", () => {
    const acceptanceCriteria = Array.from(
      { length: 257 },
      (_, index) => `historical criterion ${index}`,
    );

    const item = WorkItem.Info.parse(
      WorkItem.upcastLegacyCompletion({
        ...baseItem,
        acceptanceCriteria,
      }),
    );

    expect(item.acceptanceCriteria).toEqual(acceptanceCriteria);
    expect(item.completionFacts.criteria).toHaveLength(257);
  });

  test("upcasts historical evidence and report arrays beyond the former boundary", () => {
    const evidence = Array.from({ length: 257 }, (_, index) => ({
      id: `evidence:historical:${index}`,
      kind: "verification",
      description: `historical evidence ${index}`,
      passed: true,
      createdAt: index + 1,
    }));
    const claims = Array.from({ length: 257 }, (_, index) => ({
      statement: `historical claim ${index}`,
      evidenceIds: evidence.map(({ id }) => id),
    }));

    const item = WorkItem.Info.parse(
      WorkItem.upcastLegacyCompletion({
        ...baseItem,
        evidence,
        completionReport: { summary: "historical", claims, caveats: [], followUps: [] },
      }),
    );

    expect(item.evidence).toHaveLength(257);
    expect(item.completionReport?.claims).toHaveLength(257);
    expect(item.completionReport?.claims[0]?.evidenceIds).toHaveLength(257);
  });

  test("upcasts legacy passed evidence as asserted rather than verified", () => {
    const item = WorkItem.Info.parse(
      WorkItem.upcastLegacyCompletion({
        ...baseItem,
        evidence: [
          {
            id: "evidence:legacy-passed",
            kind: "verification",
            description: "Legacy evidence passed",
            passed: true,
            createdAt: 6,
          },
        ],
        completionReport: {
          summary: "Legacy completion",
          claims: [
            {
              statement: "The artifact was published",
              evidenceIds: ["evidence:legacy-passed"],
            },
          ],
          caveats: [],
          followUps: [],
        },
      }),
    );

    expect(item.completionFacts.results).toEqual([
      expect.objectContaining({
        value: "asserted",
      }),
    ]);
    expect("checkedPredicate" in (item.completionFacts.results[0] ?? {})).toBe(false);
  });

  test("requires checked predicates only for decisive criterion results", () => {
    const asserted = {
      id: "result:asserted",
      criterionId: "criterion:publish",
      value: "asserted",
      observationIds: [],
      assumptions: [],
      basisRef: "basis:v1",
      residualRisks: ["claimant-supplied assertion"],
      createdAt: 4,
    } as const;
    const decisive = {
      ...asserted,
      id: "result:verified",
      value: "verified",
      checkedPredicate: "artifact is published",
      residualRisks: [],
    } as const;

    expect(WorkItem.CriterionResult.safeParse(asserted).success).toBe(true);
    expect(
      WorkItem.CriterionResult.safeParse({
        ...asserted,
        checkedPredicate: "assertion only; no predicate verified",
      }).success,
    ).toBe(false);
    expect(WorkItem.CriterionResult.safeParse(decisive).success).toBe(true);
    expect(
      WorkItem.CriterionResult.safeParse({
        ...decisive,
        checkedPredicate: undefined,
      }).success,
    ).toBe(false);
  });

  test("parses a versioned request-to-admission-to-terminal receipt linkage", () => {
    expect(WorkItem.CompletionRequest).toBeDefined();
    expect(WorkItem.Events.CompletionRequested.name).toBe("work.complete.requested");

    const request = WorkItem.Events.CompletionRequested.schema.parse({
      traceId: "trace:request",
      time: 6,
      payload: {
        version: 1,
        id: "completion-request:one",
        origin: "worker",
        workItemHash: baseItem.hash,
        contractRevision: "contract:v1",
        basisRef: "basis:v1",
        expectedHead: 3,
        ownerOverrideReceiptRef: "owner-receipt:candidate",
        claims: [],
        observations: [],
        results: [
          {
            id: "result:publish",
            criterionId: "criterion:publish",
            value: "verified",
            checkedPredicate: "artifact is published",
            observationIds: [],
            verifierRef: "verifier:registry:v1",
            assumptions: [],
            basisRef: "basis:v1",
            residualRisks: [],
            createdAt: 6,
          },
        ],
        invalidations: [],
        verificationErrors: [],
        effects: [],
      },
    }).payload;
    expect(request.ownerOverrideReceiptRef).toBe("owner-receipt:candidate");
    for (const [field, value] of [
      ["criteria", [{ id: "criterion:replacement" }]],
      ["policy", { verdict: "allow" }],
      ["stakes", { value: 0 }],
      ["ownerAuthority", { authorized: true }],
    ] as const) {
      expect(WorkItem.CompletionRequest.safeParse({ ...request, [field]: value }).success).toBe(
        false,
      );
    }
    const admission = WorkItem.CompletionAdmission.parse({
      version: 1,
      id: "admission:one",
      requestId: request.id,
      requestSnapshot: request,
      origin: request.origin,
      contractRevision: request.contractRevision,
      basisRef: request.basisRef,
      effectiveResultIds: ["result:publish"],
      unresolvedCriterionIds: [],
      decision: "admit",
      reasonCodes: [],
      residualRisks: [],
      policyRef: "policy:completion:v1",
      expectedHead: request.expectedHead,
      recordedHead: 4,
      createdAt: 7,
    });
    const legacyReceipt = WorkItem.Events.Completed.schema.parse({
      traceId: "trace:legacy",
      time: 8,
      payload: { hash: request.workItemHash, sessionId: "session:legacy" },
    });
    const terminalReceipt = WorkItem.Events.CompletedV2.schema.parse({
      traceId: "trace:one",
      time: 8,
      payload: {
        version: 1,
        hash: request.workItemHash,
        requestId: request.id,
        admissionId: admission.id,
        contractRevision: admission.contractRevision,
        basisRef: admission.basisRef,
        recordedHead: admission.recordedHead,
      },
    });

    expect(legacyReceipt.payload).toEqual({
      hash: request.workItemHash,
      sessionId: "session:legacy",
    });
    expect(terminalReceipt.payload).toEqual({
      version: 1,
      hash: request.workItemHash,
      requestId: request.id,
      admissionId: admission.id,
      contractRevision: request.contractRevision,
      basisRef: request.basisRef,
      recordedHead: admission.recordedHead,
    });
  });

  test("rejects versionless current completion contracts, facts, and admissions", () => {
    const outcomes = [
      WorkItem.CompletionContract.safeParse({
        revision: "contract:v1",
        basisRef: "basis:v1",
      }).success,
      WorkItem.CompletionFacts.safeParse({
        revision: 0,
        criteria: [],
        claims: [],
        observations: [],
        results: [],
        invalidations: [],
        verificationErrors: [],
        effects: [],
        admissions: [],
      }).success,
      WorkItem.CompletionAdmission.safeParse({
        id: "admission:versionless",
        requestId: "completion-request:versionless",
        origin: "worker",
        contractRevision: "contract:v1",
        basisRef: "basis:v1",
        effectiveResultIds: [],
        unresolvedCriterionIds: [],
        decision: "block",
        reasonCodes: ["required_result_missing"],
        residualRisks: [],
        policyRef: "policy:completion:v1",
        expectedHead: 0,
        recordedHead: 1,
        createdAt: 7,
      }).success,
    ];

    expect(outcomes).toEqual([false, false, false]);
  });

  test("requires owner override receipts and consecutive admission heads", () => {
    const baseAdmission = {
      version: 1,
      id: "admission:one",
      requestId: "completion-request:one",
      requestSnapshot: completionRequestSnapshot(),
      origin: "worker",
      contractRevision: "contract:v1",
      basisRef: "basis:v1",
      effectiveResultIds: [],
      unresolvedCriterionIds: ["criterion:publish"],
      reasonCodes: ["required_result_missing"],
      residualRisks: ["publication is unverified"],
      policyRef: "policy:completion:v1",
      expectedHead: 3,
      recordedHead: 4,
      createdAt: 7,
    };

    const { requestSnapshot: _requestSnapshot, ...withoutRequestSnapshot } = baseAdmission;
    expect(WorkItem.CompletionAdmission.safeParse(withoutRequestSnapshot).success).toBe(false);
    expect(
      WorkItem.CompletionAdmission.safeParse({
        ...baseAdmission,
        requestSnapshot: { ...baseAdmission.requestSnapshot, id: "completion-request:other" },
        decision: "block",
      }).success,
    ).toBe(false);
    expect(
      WorkItem.CompletionAdmission.safeParse({
        ...baseAdmission,
        requestSnapshot: { ...baseAdmission.requestSnapshot, policyRef: "claimant:forged" },
        decision: "block",
      }).success,
    ).toBe(false);
    expect(() =>
      WorkItem.CompletionAdmission.parse({
        ...baseAdmission,
        decision: "owner_override",
      }),
    ).toThrow();
    expect(() =>
      WorkItem.CompletionAdmission.parse({
        ...baseAdmission,
        decision: "block",
        recordedHead: 5,
      }),
    ).toThrow();
    expect(
      WorkItem.CompletionAdmission.safeParse({
        ...baseAdmission,
        decision: "admit",
      }).success,
      "admit must never carry unresolved required criteria",
    ).toBe(false);
    expect(
      WorkItem.CompletionAdmission.safeParse({
        ...baseAdmission,
        decision: "owner_override",
        ownerOverrideReceiptRef: "owner-receipt:one",
      }).success,
      "Owner override receipt must be bound to the request snapshot",
    ).toBe(false);
    expect(
      WorkItem.CompletionAdmission.parse({
        ...baseAdmission,
        requestSnapshot: completionRequestSnapshot({
          ownerOverrideReceiptRef: "owner-receipt:one",
        }),
        decision: "owner_override",
        ownerOverrideReceiptRef: "owner-receipt:one",
      }).decision,
    ).toBe("owner_override");
  });

  test("terminal linkage independently rejects admit with unresolved criteria", () => {
    const malformedAdmission = {
      version: 1 as const,
      id: "admission:hostile-unresolved",
      requestId: "completion-request:hostile-unresolved",
      requestSnapshot: completionRequestSnapshot({
        id: "completion-request:hostile-unresolved",
        expectedHead: 0,
      }),
      origin: "worker" as const,
      contractRevision: "contract:v1",
      basisRef: "basis:v1",
      effectiveResultIds: [],
      unresolvedCriterionIds: ["criterion:publish"],
      decision: "admit" as const,
      reasonCodes: [],
      residualRisks: [],
      policyRef: "policy:hostile",
      expectedHead: 0,
      recordedHead: 1,
      createdAt: 7,
    };
    const issues: Array<{ path?: PropertyKey[] }> = [];

    validateTerminalLinkage(
      {
        hash: baseItem.hash,
        revision: 2,
        attempt: 1,
        timestamps: { completed: 8 },
        evidence: [],
        completionContract: { version: 1, revision: "contract:v1", basisRef: "basis:v1" },
        completionFacts: {
          criteria: [],
          claims: [],
          observations: [],
          results: [],
          admissions: [malformedAdmission as WorkItem.CompletionAdmission],
        },
        completionTerminalReceipt: {
          version: 1,
          hash: baseItem.hash,
          requestId: malformedAdmission.requestId,
          admissionId: malformedAdmission.id,
          contractRevision: malformedAdmission.contractRevision,
          basisRef: malformedAdmission.basisRef,
          recordedHead: 2,
        },
      },
      { addIssue: (issue: { path?: PropertyKey[] }) => issues.push(issue) } as never,
    );

    expect(issues.some(({ path }) => path?.includes("unresolvedCriterionIds"))).toBe(true);
  });

  test("rejects legacy generic passed bits on criterion results", () => {
    expect(() =>
      WorkItem.CriterionResult.parse({
        id: "result:publish",
        criterionId: "criterion:publish",
        value: "verified",
        passed: true,
        checkedPredicate: "artifact is published",
        observationIds: ["observation:publish"],
        assumptions: [],
        basisRef: "basis:v1",
        residualRisks: [],
        createdAt: 4,
      }),
    ).toThrow();
  });
});
