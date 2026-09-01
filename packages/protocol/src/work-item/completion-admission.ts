import { z } from "zod";
import { createHash } from "node:crypto";
import { EpochMs } from "../time.js";

const Reference = z.string().min(1);
const Timestamp = EpochMs;
const CurrentVersion = z.literal(1);

export const CompletionReport = z.object({
  summary: z.string().min(1),
  claims: z
    .array(
      z.object({
        statement: z.string().min(1),
        evidenceIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  caveats: z.array(z.string().min(1)).default([]),
  followUps: z.array(z.string().min(1)).default([]),
});
export type CompletionReport = z.infer<typeof CompletionReport>;

export const Criterion = z
  .object({
    id: Reference,
    revision: z.number().int().positive(),
    statement: Reference,
    required: z.boolean(),
  })
  .strict();
export type Criterion = z.infer<typeof Criterion>;

export const Claim = z
  .object({
    id: Reference,
    criterionId: Reference,
    statement: Reference,
    observationIds: z.array(Reference),
    basisRef: Reference,
    createdAt: Timestamp,
  })
  .strict();
export type Claim = z.infer<typeof Claim>;

export const Observation = z
  .object({
    id: Reference,
    producer: Reference,
    subjectRef: Reference,
    basisRef: Reference,
    artifactRefs: z.array(Reference),
    provenanceRef: Reference.optional(),
    ancestryRefs: z.array(Reference),
    observedAt: Timestamp,
  })
  .strict();
export type Observation = z.infer<typeof Observation>;

export const ResultValue = z.enum(["verified", "refuted", "inconclusive", "asserted"]);
export type ResultValue = z.infer<typeof ResultValue>;

const CriterionResultBase = {
  id: Reference,
  criterionId: Reference,
  observationIds: z.array(Reference),
  verifierRef: Reference.optional(),
  assumptions: z.array(Reference),
  scope: Reference.optional(),
  basisRef: Reference,
  residualRisks: z.array(Reference),
  createdAt: Timestamp,
};

export const CriterionResult = z.discriminatedUnion("value", [
  z
    .object({
      ...CriterionResultBase,
      value: z.literal("asserted"),
    })
    .strict(),
  z
    .object({
      ...CriterionResultBase,
      value: z.enum(["verified", "refuted", "inconclusive"]),
      checkedPredicate: Reference,
    })
    .strict(),
]);
export type CriterionResult = z.infer<typeof CriterionResult>;

export const ResultInvalidation = z
  .object({
    id: Reference,
    resultId: Reference,
    basisRef: Reference,
    reason: Reference,
    createdAt: Timestamp,
  })
  .strict();
export type ResultInvalidation = z.infer<typeof ResultInvalidation>;

export const VerificationErrorCode = z.enum([
  "malformed_input",
  "malformed_output",
  "verifier_crash",
  "prohibited_capability",
  "forbidden_action",
]);
export type VerificationErrorCode = z.infer<typeof VerificationErrorCode>;

export const VerificationErrorFact = z
  .object({
    id: Reference,
    criterionId: Reference,
    code: VerificationErrorCode,
    detail: z.string().min(1).max(2_048),
    verifierRef: Reference.optional(),
    basisRef: Reference,
    createdAt: Timestamp,
  })
  .strict();
export type VerificationErrorFact = z.infer<typeof VerificationErrorFact>;

const EffectOutcome = z.enum(["unknown", "confirmed", "failed"]);

export const EffectRecord = z
  .object({
    id: Reference,
    attempt: z.number().int().positive(),
    intentRef: Reference,
    outcome: EffectOutcome.optional(),
    createdAt: Timestamp,
  })
  .strict();
export type EffectRecord = z.infer<typeof EffectRecord>;

export const CompletionOrigin = z.enum([
  "resident",
  "worker",
  "external_actor",
  "replay",
  "recovery",
]);
export type CompletionOrigin = z.infer<typeof CompletionOrigin>;

export const CompletionIdentity = z
  .object({
    kind: z.enum(["resident", "worker", "external_actor"]),
    id: Reference,
  })
  .strict();
export type CompletionIdentity = z.infer<typeof CompletionIdentity>;

const FixedCompletionSource = z.enum(["internal_worker", "connector_worker", "replay", "recovery"]);
export const CompletionSource = z.enum([
  ...FixedCompletionSource.options,
  "api",
  "a2a",
  "human",
  "resident",
  "sdk",
  "internal",
]);
export type CompletionSource = z.infer<typeof CompletionSource>;

const CompletionSourceShape = z
  .object({
    source: CompletionSource,
    identity: CompletionIdentity.optional(),
  })
  .strict();

type FixedCompletionSourceValue = z.infer<typeof FixedCompletionSource>;
type QualifiedCompletionSource = Exclude<CompletionSource, FixedCompletionSourceValue>;

/** Command-surface input: fixed worker/replay/recovery sources arrive without
 *  identity (it is synthesized from the execution result, so a caller-supplied
 *  identity is rejected as forgery); qualified sources must carry
 *  caller-authenticated identity. Zod 4 dropped type-predicate refinements,
 *  so the schema is cast to the conditional union below: `{ source: "api" }`
 *  and `{ source: "internal_worker", identity }` stay rejected at compile
 *  time as well as by parse. */
export const CompletionSourceOrigin = CompletionSourceShape.superRefine((origin, ctx) => {
  if (isFixedCompletionSource(origin.source)) {
    if (origin.identity !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "fixed completion sources reject caller-supplied identity",
        path: ["identity"],
      });
    }
    return;
  }
  if (origin.identity === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "qualified completion sources require identity",
      path: ["identity"],
    });
  }
}) as unknown as z.ZodType<CompletionSourceOrigin, z.input<typeof CompletionSourceShape>>;
export type CompletionSourceOrigin =
  | { source: FixedCompletionSourceValue; identity?: never }
  | { source: QualifiedCompletionSource; identity: CompletionIdentity };

/** Durable form: identity always present. Replaces the 10-arm union. */
export const CompletionSourceIdentity = CompletionSourceShape.required({ identity: true });
export type CompletionSourceIdentity = z.infer<typeof CompletionSourceIdentity>;

function isFixedCompletionSource(
  source: CompletionSource,
): source is z.infer<typeof FixedCompletionSource> {
  return (FixedCompletionSource.options as readonly string[]).includes(source);
}

export function projectCompletionOrigin(
  input: CompletionSourceOrigin | CompletionSourceIdentity,
): CompletionOrigin {
  switch (input.source) {
    case "internal_worker":
    case "connector_worker":
      return "worker";
    case "replay":
    case "recovery":
      return input.source;
    default:
      return input.identity.kind; // resident | worker | external_actor map 1:1
  }
}

export function projectCompletionSourceIdentity(
  input: CompletionSourceOrigin,
): CompletionSourceIdentity | undefined {
  return input.identity === undefined ? undefined : CompletionSourceIdentity.parse(input);
}

/** Shared origin-consistency refinement used by CompletionRequest AND CompletionAdmission. */
function validateSourceIdentityOrigin(
  origin: CompletionOrigin,
  sourceIdentity: CompletionSourceIdentity | undefined,
  ctx: z.RefinementCtx,
): void {
  if (sourceIdentity === undefined) return;
  if (isFixedCompletionSource(sourceIdentity.source)) {
    if (origin !== projectCompletionOrigin(sourceIdentity)) {
      ctx.addIssue({
        code: "custom",
        message: "sourceIdentity source must match completion origin",
        path: ["sourceIdentity", "source"],
      });
    }
    if (sourceIdentity.identity.kind !== "worker") {
      ctx.addIssue({
        code: "custom",
        message: "fixed Worker source requires worker identity",
        path: ["sourceIdentity", "identity", "kind"],
      });
    }
    return;
  }
  if (origin !== sourceIdentity.identity.kind) {
    ctx.addIssue({
      code: "custom",
      message: "sourceIdentity kind must match completion origin",
      path: ["sourceIdentity", "identity", "kind"],
    });
  }
}

export const CompletionDecision = z.enum(["admit", "block", "escalate", "owner_override"]);
export type CompletionDecision = z.infer<typeof CompletionDecision>;

export const CompletionContract = z
  .object({
    version: CurrentVersion,
    revision: Reference,
    basisRef: Reference,
  })
  .strict();
export type CompletionContract = z.infer<typeof CompletionContract>;

/** Fact ids must be unique ACROSS collections, not merely within each one. */
function requireUniqueFactIds(
  ctx: z.RefinementCtx,
  collections: ReadonlyArray<readonly [string, ReadonlyArray<Readonly<{ id: string }>>]>,
): void {
  const seen = new Set<string>();
  for (const [collection, entries] of collections) {
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate completion fact id: ${entry.id}`,
          path: [collection, index, "id"],
        });
      }
      seen.add(entry.id);
    }
  }
}

/**
 * Single owner of the proposable fact collections. A completion request
 * PROPOSES these; the facts snapshot ACCUMULATES them plus criteria,
 * reservations, and admissions, which a request can never carry. Both
 * spellings must stay identical or a proposal could name a collection the
 * snapshot cannot hold.
 */
const proposableFactCollections = {
  claims: z.array(Claim),
  observations: z.array(Observation),
  results: z.array(CriterionResult),
  invalidations: z.array(ResultInvalidation),
  verificationErrors: z.array(VerificationErrorFact),
  effects: z.array(EffectRecord),
} as const;

/**
 * The unique-id check list for the collections above, in schema order. Issue
 * paths are `[collection, index, "id"]`, so the ORDER of this list is part of
 * the observable contract (see the shapes characterization test).
 */
function proposableFactEntries(
  source: Readonly<{
    claims: readonly { id: string }[];
    observations: readonly { id: string }[];
    results: readonly { id: string }[];
    invalidations: readonly { id: string }[];
    verificationErrors: readonly { id: string }[];
    effects: readonly { id: string }[];
  }>,
): [string, readonly { id: string }[]][] {
  return [
    ["claims", source.claims],
    ["observations", source.observations],
    ["results", source.results],
    ["invalidations", source.invalidations],
    ["verificationErrors", source.verificationErrors],
    ["effects", source.effects],
  ];
}

/**
 * Single owner of the ledger head-adjacency rule: a recorded head immediately
 * follows the head the writer expected. Spelled once and applied at every
 * head-bearing site (admission, request reservation) so the two cannot drift.
 */
function requireAdjacentHead(
  ctx: z.RefinementCtx,
  heads: Readonly<{ expectedHead: number; recordedHead: number }>,
): void {
  if (heads.recordedHead !== heads.expectedHead + 1) {
    ctx.addIssue({
      code: "custom",
      message: "recordedHead must immediately follow expectedHead",
      path: ["recordedHead"],
    });
  }
}

const CompletionRequestShape = z
  .object({
    version: CurrentVersion,
    id: Reference,
    origin: CompletionOrigin,
    sourceIdentity: CompletionSourceIdentity.optional(),
    workItemHash: Reference,
    contractRevision: Reference,
    basisRef: Reference,
    expectedHead: z.number().int().nonnegative(),
    ownerOverrideReceiptRef: Reference.optional(),
    ...proposableFactCollections,
  })
  .strict()
  .superRefine((request, ctx) => {
    requireUniqueFactIds(ctx, proposableFactEntries(request));
    validateSourceIdentityOrigin(request.origin, request.sourceIdentity, ctx);
  });

export const CompletionRequest = CompletionRequestShape;
export type CompletionRequest = z.infer<typeof CompletionRequest>;

const ProposedFactIds = z
  .object({
    claims: z.array(Reference),
    observations: z.array(Reference),
    results: z.array(Reference),
    invalidations: z.array(Reference),
    verificationErrors: z.array(Reference),
    effects: z.array(Reference),
  })
  .strict();

const CompletionAdmissionShape = z
  .object({
    version: CurrentVersion,
    id: Reference,
    requestId: Reference,
    workItemHash: Reference,
    origin: CompletionOrigin,
    sourceIdentity: CompletionSourceIdentity.optional(),
    contractRevision: Reference,
    basisRef: Reference,
    requestRoot: Reference,
    proposedFactIds: ProposedFactIds,
    effectiveResultIds: z.array(Reference),
    unresolvedCriterionIds: z.array(Reference),
    decision: CompletionDecision,
    reasonCodes: z.array(Reference),
    residualRisks: z.array(Reference),
    policyRef: Reference,
    stakesRef: Reference.optional(),
    ownerOverrideReceiptRef: Reference.optional(),
    completionReportSnapshot: CompletionReport.optional(),
    completionReportRef: Reference.optional(),
    expectedHead: z.number().int().nonnegative(),
    recordedHead: z.number().int().positive(),
    createdAt: Timestamp,
  })
  .strict();

export const CompletionAdmission = CompletionAdmissionShape.superRefine((admission, ctx) => {
  validateSourceIdentityOrigin(admission.origin, admission.sourceIdentity, ctx);
  if (
    (admission.completionReportSnapshot === undefined) !==
    (admission.completionReportRef === undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "completion report snapshot and reference must be recorded together",
      path: ["completionReportSnapshot"],
    });
  }
  if (
    admission.completionReportSnapshot !== undefined &&
    admission.completionReportRef !== completionReportReference(admission.completionReportSnapshot)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "completion report reference must match its canonical snapshot",
      path: ["completionReportRef"],
    });
  }
  requireAdjacentHead(ctx, admission);
  if (admission.decision === "admit" && admission.unresolvedCriterionIds.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: "admit cannot carry unresolved required criteria",
      path: ["unresolvedCriterionIds"],
    });
  }
  if (admission.decision === "owner_override" && !admission.ownerOverrideReceiptRef) {
    ctx.addIssue({
      code: "custom",
      message: "owner_override requires ownerOverrideReceiptRef",
      path: ["ownerOverrideReceiptRef"],
    });
  }
  if (admission.decision !== "owner_override" && admission.ownerOverrideReceiptRef) {
    ctx.addIssue({
      code: "custom",
      message: "ownerOverrideReceiptRef is valid only for owner_override",
      path: ["ownerOverrideReceiptRef"],
    });
  }
});
export type CompletionAdmission = z.infer<typeof CompletionAdmission>;

export const CompletionRequestReservation = z
  .object({
    version: CurrentVersion,
    id: Reference,
    requestId: Reference,
    requestRoot: Reference,
    attempt: z.number().int().positive().optional(),
    basisRef: Reference.optional(),
    envelopeDigest: Reference,
    expectedHead: z.number().int().nonnegative(),
    recordedHead: z.number().int().positive(),
    createdAt: Timestamp,
    ownerId: Reference.optional(),
    fence: z.number().int().nonnegative().default(0),
    leaseExpiresAt: Timestamp.optional(),
  })
  .strict()
  .superRefine((reservation, ctx) => {
    requireAdjacentHead(ctx, reservation);
    const held = reservation.ownerId !== undefined;
    if (held !== (reservation.leaseExpiresAt !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "ownerId and leaseExpiresAt must be present together",
        path: ["ownerId"],
      });
    }
    if (held && reservation.fence < 1) {
      ctx.addIssue({
        code: "custom",
        message: "held reservations require a positive fence",
        path: ["fence"],
      });
    }
    if (!held && reservation.fence !== 0) {
      ctx.addIssue({
        code: "custom",
        message: "unheld reservations require fence zero",
        path: ["fence"],
      });
    }
    if (
      reservation.leaseExpiresAt !== undefined &&
      reservation.leaseExpiresAt < reservation.createdAt
    ) {
      ctx.addIssue({
        code: "custom",
        message: "leaseExpiresAt must not precede createdAt",
        path: ["leaseExpiresAt"],
      });
    }
  });
export type CompletionRequestReservation = z.infer<typeof CompletionRequestReservation>;

const CompletionFactsShape = z
  .object({
    version: CurrentVersion,
    revision: z.number().int().nonnegative(),
    criteria: z.array(Criterion),
    ...proposableFactCollections,
    requestReservations: z.array(CompletionRequestReservation),
    admissions: z.array(CompletionAdmission),
  })
  .strict()
  .superRefine((facts, ctx) => {
    // `criteria` leads and the durable-only collections trail: a request can
    // propose neither, so they are not part of the shared proposable map.
    requireUniqueFactIds(ctx, [
      ["criteria", facts.criteria],
      ...proposableFactEntries(facts),
      ["requestReservations", facts.requestReservations],
      ["admissions", facts.admissions],
    ]);
  });

export const CompletionFacts = CompletionFactsShape;
export type CompletionFacts = z.infer<typeof CompletionFacts>;

export const CompletionTerminalReceipt = z
  .object({
    version: CurrentVersion,
    hash: Reference,
    requestId: Reference,
    admissionId: Reference,
    contractRevision: Reference,
    basisRef: Reference,
    completionReportRef: Reference.optional(),
    recordedHead: z.number().int().positive(),
  })
  .strict();
export type CompletionTerminalReceipt = z.infer<typeof CompletionTerminalReceipt>;

export function emptyCompletionFacts(): CompletionFacts {
  return {
    version: 1,
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
  };
}

export function canonicalCompletionReport(input: CompletionReport): CompletionReport {
  const report = CompletionReport.parse(input);
  return CompletionReport.parse({
    ...report,
    claims: report.claims.map((claim) => ({
      ...claim,
      evidenceIds: [...new Set(claim.evidenceIds)].sort(),
    })),
  });
}

/**
 * FROZEN BYTES — do not change this serialization. `completionReportRef`
 * equality is re-verified inside `CompletionAdmission`'s superRefine on
 * every parse of a persisted admission row, so any algorithm change breaks
 * historical rows. Determinism holds without key sorting because the input
 * is `CompletionReport.parse` output: a closed zod object whose key order
 * is fixed by the schema shape.
 */
export function completionReportReference(input: CompletionReport): string {
  const bytes = JSON.stringify(canonicalCompletionReport(input));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
