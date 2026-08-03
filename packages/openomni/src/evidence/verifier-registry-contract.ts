import { z } from "zod";
import {
  type JsonValue as CanonicalJsonValue,
  JsonObjectSchema,
  JsonValueSchema,
  Sha256DigestSchema,
} from "./verifier-conformance-canonical.js";

export const ObligationKind = z.enum([
  "schema_validity",
  "numeric_recheck",
  "code_recheck",
  "archived_url_recheck",
  "archived_api_recheck",
  "hash_recheck",
  "archived_quote_match",
  "citation_support",
  "reasoning",
  "subjective",
  "creative",
  "opinion",
  "prediction",
  "normative_ethical",
  "out_of_archive",
]);
export type ObligationKind = z.infer<typeof ObligationKind>;

export const AssertedOnlyKind = z.enum([
  "reasoning",
  "subjective",
  "creative",
  "opinion",
  "prediction",
  "normative_ethical",
  "out_of_archive",
]);
export type AssertedOnlyKind = z.infer<typeof AssertedOnlyKind>;

export const ResultStatus = z.enum(["verified", "refuted", "inconclusive", "asserted"]);
export type ResultStatus = z.infer<typeof ResultStatus>;
export const SandboxCapability = z.enum(["network", "clock", "subprocess", "live_llm", "device"]);
export type SandboxCapability = z.infer<typeof SandboxCapability>;
export const ForbiddenAction = z.enum([
  "session_import",
  "persist",
  "admit",
  "complete",
  "fold",
  "effect",
  "replay",
]);
export type ForbiddenAction = z.infer<typeof ForbiddenAction>;

export type JsonValue = CanonicalJsonValue;
export const JsonValue = JsonValueSchema;

export const Obligation = z
  .object({
    obligationId: z.string().min(1).max(512),
    kind: ObligationKind,
    claim: z.string().min(1).max(65_536),
    recordedInputs: JsonObjectSchema,
  })
  .strict();
export type Obligation = z.infer<typeof Obligation>;

export const VerifierProgram = z
  .object({
    version: z.literal("verifier-program-v1"),
    outputVersion: z.string().min(1).max(256),
    capabilities: z.array(SandboxCapability).max(SandboxCapability.options.length),
    actions: z.array(ForbiddenAction).max(ForbiddenAction.options.length),
  })
  .strict();
export type VerifierProgram = z.infer<typeof VerifierProgram>;
export const VerificationRequest = z
  .object({ obligation: Obligation, program: VerifierProgram })
  .strict();
export type VerificationRequest = z.infer<typeof VerificationRequest>;

export const VerificationResult = z
  .object({
    type: z.literal("verification_result"),
    obligationId: z.string().min(1).max(512),
    kind: ObligationKind,
    verifierId: z.string().min(1).max(256),
    status: ResultStatus,
    basisHash: Sha256DigestSchema,
    checkedPredicate: z.string().min(1).max(2_048).optional(),
    modelFingerprint: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    const assertedOnly = AssertedOnlyKind.safeParse(result.kind).success;
    if (assertedOnly && result.status !== "asserted") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "asserted-only kinds must remain asserted",
      });
    }
    if (assertedOnly && result.checkedPredicate !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "asserted-only results cannot carry a checked predicate",
      });
    }
    if (assertedOnly && result.checkedPredicate !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "asserted-only results cannot carry a checked predicate",
      });
    }
    if (!assertedOnly && result.status === "asserted") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "executable kinds cannot be asserted",
      });
    }
    if (!assertedOnly && result.checkedPredicate === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "executable results need a checked predicate",
      });
    }
    if (result.kind === "citation_support" && result.modelFingerprint === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "citation support needs a model" });
    }
    if (result.kind !== "citation_support" && result.modelFingerprint !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "only citation support carries a model fingerprint",
      });
    }
  });
export type VerificationResult = z.infer<typeof VerificationResult>;

export const VerificationErrorCode = z.enum([
  "malformed_input",
  "malformed_output",
  "verifier_crash",
  "prohibited_capability",
  "forbidden_action",
]);
export type VerificationErrorCode = z.infer<typeof VerificationErrorCode>;
export const VerificationError = z
  .object({
    type: z.literal("verification_error"),
    code: VerificationErrorCode,
    detail: z.string().min(1).max(2_048),
    obligationId: z.string().min(1).max(512).optional(),
    kind: ObligationKind.optional(),
    verifierId: z.string().min(1).max(256).optional(),
    violation: z.union([SandboxCapability, ForbiddenAction]).optional(),
  })
  .strict();
export type VerificationError = z.infer<typeof VerificationError>;
export const VerificationFact = z.union([VerificationResult, VerificationError]);
export type VerificationFact = z.infer<typeof VerificationFact>;

export interface Registry {
  verify(input: unknown): VerificationFact;
}
