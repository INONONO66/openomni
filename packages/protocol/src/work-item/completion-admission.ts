import { createHash } from "node:crypto";
import { z } from "zod";

const Reference = z.string().min(1);
const Timestamp = z.number().finite();
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

export const EffectOutcome = z.enum(["unknown", "confirmed", "failed"]);
export type EffectOutcome = z.infer<typeof EffectOutcome>;

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

const CompletionRequestShape = z
  .object({
    version: CurrentVersion,
    id: Reference,
    origin: CompletionOrigin,
    workItemHash: Reference,
    contractRevision: Reference,
    basisRef: Reference,
    expectedHead: z.number().int().nonnegative(),
    ownerOverrideReceiptRef: Reference.optional(),
    claims: z.array(Claim),
    observations: z.array(Observation),
    results: z.array(CriterionResult),
    invalidations: z.array(ResultInvalidation),
    verificationErrors: z.array(VerificationErrorFact),
    effects: z.array(EffectRecord),
  })
  .strict();

export const CompletionRequest = CompletionRequestShape;
export type CompletionRequest = z.infer<typeof CompletionRequest>;

const CompletionAdmissionShape = z
  .object({
    version: CurrentVersion,
    id: Reference,
    requestId: Reference,
    requestSnapshot: CompletionRequestShape,
    origin: CompletionOrigin,
    contractRevision: Reference,
    basisRef: Reference,
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
  if (
    admission.requestSnapshot.id !== admission.requestId ||
    admission.requestSnapshot.origin !== admission.origin ||
    admission.requestSnapshot.contractRevision !== admission.contractRevision ||
    admission.requestSnapshot.basisRef !== admission.basisRef ||
    admission.requestSnapshot.expectedHead !== admission.expectedHead
  ) {
    ctx.addIssue({
      code: "custom",
      message: "requestSnapshot must match the admission subject",
      path: ["requestSnapshot"],
    });
  }
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
  if (admission.recordedHead !== admission.expectedHead + 1) {
    ctx.addIssue({
      code: "custom",
      message: "recordedHead must immediately follow expectedHead",
      path: ["recordedHead"],
    });
  }
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
  if (
    admission.decision === "owner_override" &&
    admission.ownerOverrideReceiptRef !== admission.requestSnapshot.ownerOverrideReceiptRef
  ) {
    ctx.addIssue({
      code: "custom",
      message: "owner_override receipt must match the request snapshot candidate",
      path: ["ownerOverrideReceiptRef"],
    });
  }
});
export type CompletionAdmission = z.infer<typeof CompletionAdmission>;

const CompletionFactsShape = z
  .object({
    version: CurrentVersion,
    revision: z.number().int().nonnegative(),
    criteria: z.array(Criterion),
    claims: z.array(Claim),
    observations: z.array(Observation),
    results: z.array(CriterionResult),
    invalidations: z.array(ResultInvalidation),
    verificationErrors: z.array(VerificationErrorFact),
    effects: z.array(EffectRecord),
    admissions: z.array(CompletionAdmission),
  })
  .strict();

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
    admissions: [],
  };
}

export function canonicalCompletionReport(input: CompletionReport): CompletionReport {
  const report = CompletionReport.parse(input);
  return CompletionReport.parse({
    ...report,
    claims: report.claims.map((claim) => ({
      ...claim,
      evidenceIds: [...claim.evidenceIds].sort(),
    })),
  });
}

export function completionReportReference(input: CompletionReport): string {
  const canonical = canonicalCompletionReport(input);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}
