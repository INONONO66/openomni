import { describe, expect, test } from "bun:test";
import { WorkItem } from "./index.js";

const baseItem = {
  workItemId: "wi_admission",
  name: "Admission contract",
  sourceMessageId: "msg_admission",
  sourceChannel: "test",
  attempt: 1,
  timestamps: { created: 1, updated: 1 },
  relations: { childIds: [], dependsOn: [] },
  intent: "complete",
  goal: "close only after admission",
  constraints: [],
  acceptanceCriteria: ["publish the artifact"],
  blockers: [],
  evidence: [],
};

function completionRequestSnapshot(overrides: Readonly<Record<string, unknown>> = {}) {
  return WorkItem.CompletionRequest.parse({
    version: 1,
    id: "completion-request:one",
    origin: "worker",
    workItemHash: baseItem.workItemId,
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
const completionReportRef = WorkItem.completionReportReference(completionReport);
const completionContract = {
  version: 1 as const,
  revision: "contract:v1",
  basisRef: "basis:v1",
};
const terminalCriterionId = WorkItem.criterionId(baseItem.workItemId, 0, "publish the artifact");
const terminalObservation = WorkItem.Observation.parse({
  id: "observation:terminal",
  producer: "verifier:terminal",
  subjectRef: baseItem.workItemId,
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
  workItemHash: baseItem.workItemId,
  origin: "worker",
  contractRevision: completionContract.revision,
  basisRef: completionContract.basisRef,
  requestRoot: "request-root:terminal",
  proposedFactIds: {
    claims: [terminalClaim.id],
    observations: [terminalObservation.id],
    results: [terminalResult.id],
    invalidations: [],
    verificationErrors: [],
    effects: [],
  },
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
  hash: baseItem.workItemId,
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

function validateTerminalLinkage(input: unknown) {
  return WorkItem.validateCompletionTerminalLinkage(WorkItem.Info.parse(input));
}

function reservationBridge(id: string) {
  return WorkItem.CompletionRequestReservation.parse({
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
}

const invalidTerminalInputs = [
  [
    "bridged-receipt-duplicate-reservation-head",
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
  ],
  [
    "missing-effective-result",
    {
      ...validInput,
      completionFacts: {
        ...completionFacts,
        results: [],
        admissions: [{ ...admission, effectiveResultIds: [] }],
      },
    },
  ],
  [
    "owner-override-unknown-unresolved-criterion",
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
          },
        ],
      },
    },
  ],
  ["missing-receipt", { ...validInput, completionTerminalReceipt: undefined }],
  ["missing-completed-timestamp", { ...validInput, timestamps: { created: 1, updated: 8 } }],
  [
    "foreign-receipt-hash",
    {
      ...validInput,
      completionTerminalReceipt: { ...completionTerminalReceipt, hash: "wi_other" },
    },
  ],
  [
    "foreign-contract-revision",
    {
      ...validInput,
      completionTerminalReceipt: {
        ...completionTerminalReceipt,
        contractRevision: "contract:other",
      },
    },
  ],
  [
    "foreign-basis",
    {
      ...validInput,
      completionTerminalReceipt: { ...completionTerminalReceipt, basisRef: "basis:other" },
    },
  ],
  [
    "receipt-head-gap",
    {
      ...validInput,
      completionTerminalReceipt: { ...completionTerminalReceipt, recordedHead: 3 },
    },
  ],
  ["no-admissions", { ...validInput, completionFacts: { ...completionFacts, admissions: [] } }],
  [
    "blocked-terminal-decision",
    {
      ...validInput,
      completionFacts: {
        ...completionFacts,
        admissions: [{ ...admission, decision: "block" }],
      },
    },
  ],
  [
    "foreign-request-id",
    {
      ...validInput,
      completionFacts: {
        ...completionFacts,
        admissions: [{ ...admission, requestId: "completion-request:other" }],
      },
    },
  ],
  [
    "foreign-work-item-hash",
    {
      ...validInput,
      completionFacts: {
        ...completionFacts,
        admissions: [{ ...admission, workItemHash: "wi_other" }],
      },
    },
  ],
  [
    "foreign-admission-contract",
    {
      ...validInput,
      completionFacts: {
        ...completionFacts,
        admissions: [{ ...admission, contractRevision: "contract:other" }],
      },
    },
  ],
  [
    "foreign-admission-basis",
    {
      ...validInput,
      completionFacts: {
        ...completionFacts,
        admissions: [{ ...admission, basisRef: "basis:other" }],
      },
    },
  ],
  [
    "non-consecutive-admission-heads",
    {
      ...validInput,
      completionFacts: {
        ...completionFacts,
        admissions: [{ ...admission, expectedHead: 1, recordedHead: 2 }],
      },
    },
  ],
  [
    "missing-report-linkage",
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
  ],
] as const;

const uncoveredCriterion = {
  id: WorkItem.criterionId(baseItem.workItemId, 1, "verify the artifact"),
  revision: 1,
  statement: "verify the artifact",
  required: true,
};
const refutedResult = WorkItem.CriterionResult.parse({
  ...terminalResult,
  id: "result:terminal-refuted",
  value: "refuted",
  checkedPredicate: "the artifact publication was checked and failed",
});
const terminalLinkageDefenses: readonly [string, unknown][] = [
  [
    "admit-uncovered-required-criterion",
    {
      ...validInput,
      acceptanceCriteria: [...validInput.acceptanceCriteria, uncoveredCriterion.statement],
      completionFacts: {
        ...completionFacts,
        criteria: [...completionFacts.criteria, uncoveredCriterion],
      },
    },
  ],
  [
    "admit-refuted-effective-result",
    {
      ...validInput,
      completionFacts: {
        ...completionFacts,
        results: [refutedResult],
        admissions: [
          {
            ...admission,
            proposedFactIds: { ...admission.proposedFactIds, results: [refutedResult.id] },
            effectiveResultIds: [refutedResult.id],
          },
        ],
      },
    },
  ],
  [
    "blocked-admission-unknown-unresolved-criterion",
    {
      ...validInput,
      completionFacts: {
        ...completionFacts,
        admissions: [
          {
            ...admission,
            decision: "block",
            unresolvedCriterionIds: ["criterion:unknown"],
          },
        ],
      },
    },
  ],
];

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
            subjectRef: baseItem.workItemId,
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

  test("rejects caller-supplied identity on fixed completion source origins", () => {
    for (const source of ["internal_worker", "connector_worker", "replay", "recovery"] as const) {
      expect(WorkItem.CompletionSourceOrigin.safeParse({ source }).success).toBe(true);
      const forged = WorkItem.CompletionSourceOrigin.safeParse({
        source,
        identity: { kind: "worker", id: "worker:forged" },
      });
      expect(forged.success).toBe(false);
      if (!forged.success) {
        expect(forged.error.issues[0]?.message).toBe(
          "fixed completion sources reject caller-supplied identity",
        );
      }
      // The durable form is unaffected: identity stays required for every source.
      expect(
        WorkItem.CompletionSourceIdentity.safeParse({
          source,
          identity: { kind: "worker", id: "worker:assigned" },
        }).success,
      ).toBe(true);
    }
  });

  test("requires caller-authenticated identity on qualified completion source origins", () => {
    for (const source of ["api", "a2a", "human", "resident", "sdk", "internal"] as const) {
      const missing = WorkItem.CompletionSourceOrigin.safeParse({ source });
      expect(missing.success).toBe(false);
      if (!missing.success) {
        expect(missing.error.issues[0]?.message).toBe(
          "qualified completion sources require identity",
        );
      }
      expect(
        WorkItem.CompletionSourceOrigin.safeParse({
          source,
          identity: { kind: "external_actor", id: "actor:assigned" },
        }).success,
      ).toBe(true);
    }
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

  test("folds contiguous completion reservation bridges structurally", () => {
    const bridge = reservationBridge("reservation:terminal:bridge");
    expect(
      WorkItem.hasContiguousReservationBridge(
        [bridge],
        admission.requestId,
        admission.recordedHead,
        admission.recordedHead + 2,
      ),
    ).toBe(true);
    expect(
      WorkItem.hasContiguousReservationBridge(
        [bridge, { ...bridge, id: "reservation:terminal:duplicate" }],
        admission.requestId,
        admission.recordedHead,
        admission.recordedHead + 2,
      ),
    ).toBe(false);
    expect(
      WorkItem.hasContiguousReservationBridge(
        [bridge],
        "completion-request:foreign",
        admission.recordedHead,
        admission.recordedHead + 2,
      ),
    ).toBe(false);
    expect(
      WorkItem.hasContiguousReservationBridge(
        [],
        admission.requestId,
        admission.recordedHead,
        admission.recordedHead + 1,
      ),
    ).toBe(false);
  });

  test("enforces terminal receipt linkage in the explicit durability fold", () => {
    const ownerRefutedResult = WorkItem.CriterionResult.parse({
      ...terminalResult,
      id: "result:terminal-owner-refuted",
      value: "refuted",
      checkedPredicate: "Owner accepted the known verification failure",
    });
    const ownerUnresolvedCriterion = {
      id: WorkItem.criterionId(baseItem.workItemId, 1, "accept the residual risk"),
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
      proposedFactIds: { ...admission.proposedFactIds, results: [ownerRefutedResult.id] },
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

    expect(validateTerminalLinkage(validInput).success).toBe(true);
    expect(validateTerminalLinkage(ownerOverrideInput).success).toBe(true);
    const missingCriterionClaim = {
      ...terminalClaim,
      criterionId: "criterion:missing",
    };
    const invalidOwnerClaim = validateTerminalLinkage({
      ...ownerOverrideInput,
      completionFacts: {
        ...ownerOverrideInput.completionFacts,
        claims: [missingCriterionClaim],
      },
    });
    expect(invalidOwnerClaim.success).toBe(false);
    if (!invalidOwnerClaim.success) {
      expect(invalidOwnerClaim.error.issues.map(({ path }) => path)).toContainEqual([
        "completionFacts",
        "claims",
        0,
        "criterionId",
      ]);
    }
    const directOwnerAdmission = WorkItem.CompletionAdmission.parse({
      ...ownerAdmission,
      id: "admission:owner-direct",
      effectiveResultIds: [],
      unresolvedCriterionIds: [terminalCriterionId],
      proposedFactIds: { ...ownerAdmission.proposedFactIds, results: [] },
    });
    expect(
      validateTerminalLinkage({
        ...validInput,
        completionFacts: {
          ...completionFacts,
          results: [],
          admissions: [directOwnerAdmission],
        },
        completionTerminalReceipt: {
          ...completionTerminalReceipt,
          admissionId: directOwnerAdmission.id,
        },
      }).success,
    ).toBe(true);
    expect(
      validateTerminalLinkage({ ...validInput, revision: 3, outcome: "adopted" }).success,
    ).toBe(true);
    const missingTerminalEvidence = validateTerminalLinkage({
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
      const duplicateTerminalEvidence = validateTerminalLinkage({
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
      const foreignObservation = validateTerminalLinkage({
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
    const danglingClaim = {
      ...terminalClaim,
      observationIds: [...terminalClaim.observationIds, "observation:missing"],
    };
    const danglingClaimObservation = validateTerminalLinkage({
      ...validInput,
      completionFacts: {
        ...completionFacts,
        claims: [danglingClaim],
      },
    });
    expect(danglingClaimObservation.success).toBe(false);
    if (!danglingClaimObservation.success) {
      expect(danglingClaimObservation.error.issues.map(({ path }) => path)).toContainEqual([
        "completionFacts",
        "claims",
        0,
        "observationIds",
        1,
      ]);
    }
  });

  test("parses completion terminal fields without exercising product authority", () => {
    expect(WorkItem.Info.safeParse(validInput).success).toBe(true);
  });

  test.each(
    invalidTerminalInputs,
  )("leaves terminal judgment to the durability fold: %s", (label, input) => {
    expect(WorkItem.Info.safeParse(input).success).toBe(true);
    expect(validateTerminalLinkage(input).success).toBe(label === "blocked-terminal-decision");
  });

  test.each(
    terminalLinkageDefenses,
  )("does not perform completion authority during parse: %s", (label, input) => {
    expect(WorkItem.Info.safeParse(input).success).toBe(true);
    expect(validateTerminalLinkage(input).success).toBe(
      label !== "blocked-admission-unknown-unresolved-criterion",
    );
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
    expect(WorkItem.Events.CompletionRequested.name).toBe("work.complete.requested");

    const request = WorkItem.Events.CompletionRequested.schema.parse({
      traceId: "trace:request",
      time: 6,
      payload: {
        version: 1,
        id: "completion-request:one",
        origin: "worker",
        workItemHash: baseItem.workItemId,
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
    const linkageAdmission = WorkItem.CompletionAdmission.parse({
      version: 1,
      id: "admission:one",
      requestId: request.id,
      workItemHash: request.workItemHash,
      origin: request.origin,
      contractRevision: request.contractRevision,
      basisRef: request.basisRef,
      requestRoot: "request-root:one",
      proposedFactIds: {
        claims: [],
        observations: [],
        results: request.results.map(({ id }) => id),
        invalidations: [],
        verificationErrors: [],
        effects: [],
      },
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
      payload: { workItemId: request.workItemHash, sessionId: "session:legacy" },
    });
    const terminalReceipt = WorkItem.Events.CompletedV2.schema.parse({
      traceId: "trace:one",
      time: 8,
      payload: {
        version: 1,
        hash: request.workItemHash,
        requestId: request.id,
        admissionId: linkageAdmission.id,
        contractRevision: linkageAdmission.contractRevision,
        basisRef: linkageAdmission.basisRef,
        recordedHead: linkageAdmission.recordedHead,
      },
    });

    expect(legacyReceipt.payload).toEqual({
      workItemId: request.workItemHash,
      sessionId: "session:legacy",
    });
    expect(terminalReceipt.payload).toEqual({
      version: 1,
      hash: request.workItemHash,
      requestId: request.id,
      admissionId: linkageAdmission.id,
      contractRevision: request.contractRevision,
      basisRef: request.basisRef,
      recordedHead: linkageAdmission.recordedHead,
    });
  });

  test("rejects versionless current completion facts and admissions", () => {
    const outcomes = [
      WorkItem.CompletionFacts.safeParse({
        revision: 0,
        criteria: [],
        claims: [],
        observations: [],
        results: [],
        invalidations: [],
        verificationErrors: [],
        effects: [],
        requestReservations: [],
        admissions: [],
      }).success,
      WorkItem.CompletionAdmission.safeParse({
        id: "admission:versionless",
        requestId: "completion-request:versionless",
        workItemHash: baseItem.workItemId,
        origin: "worker",
        contractRevision: "contract:v1",
        basisRef: "basis:v1",
        requestRoot: "request-root:versionless",
        proposedFactIds: {
          claims: [],
          observations: [],
          results: [],
          invalidations: [],
          verificationErrors: [],
          effects: [],
        },
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

    expect(outcomes).toEqual([false, false]);
  });

  test("requires owner override receipts and consecutive admission heads", () => {
    const baseAdmission = {
      version: 1,
      id: "admission:one",
      requestId: "completion-request:one",
      workItemHash: baseItem.workItemId,
      origin: "worker",
      contractRevision: "contract:v1",
      basisRef: "basis:v1",
      requestRoot: "request-root:one",
      proposedFactIds: {
        claims: [],
        observations: [],
        results: [],
        invalidations: [],
        verificationErrors: [],
        effects: [],
      },
      effectiveResultIds: [],
      unresolvedCriterionIds: ["criterion:publish"],
      reasonCodes: ["required_result_missing"],
      residualRisks: ["publication is unverified"],
      policyRef: "policy:completion:v1",
      expectedHead: 3,
      recordedHead: 4,
      createdAt: 7,
    };

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
        decision: "block",
        ownerOverrideReceiptRef: "owner-receipt:one",
      }).success,
      "ownerOverrideReceiptRef is valid only for owner_override",
    ).toBe(false);
    expect(
      WorkItem.CompletionAdmission.parse({
        ...baseAdmission,
        decision: "owner_override",
        ownerOverrideReceiptRef: "owner-receipt:one",
      }).decision,
    ).toBe("owner_override");
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
