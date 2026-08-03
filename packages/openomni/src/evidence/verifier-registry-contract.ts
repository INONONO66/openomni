import { z } from "zod";

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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(JsonValue),
  ]),
);

export const Obligation = z
  .object({
    obligationId: z.string().min(1),
    kind: ObligationKind,
    claim: z.string().min(1),
    recordedInputs: z.record(JsonValue),
  })
  .strict();
export type Obligation = z.infer<typeof Obligation>;

export const VerifierProgram = z
  .object({
    version: z.literal("verifier-program-v1"),
    outputVersion: z.string().min(1),
    capabilities: z.array(SandboxCapability),
    actions: z.array(ForbiddenAction),
  })
  .strict();
export type VerifierProgram = z.infer<typeof VerifierProgram>;
export const VerificationRequest = z
  .object({ obligation: Obligation, program: VerifierProgram })
  .strict();

export const VerificationResult = z
  .object({
    type: z.literal("verification_result"),
    obligationId: z.string().min(1),
    kind: ObligationKind,
    verifierId: z.string().min(1),
    status: ResultStatus,
    checkedPredicate: z.string().min(1).optional(),
    modelFingerprint: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      (result.status === "verified" || result.status === "refuted") &&
      result.checkedPredicate === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "decisive results need a predicate",
      });
    }
    if (result.kind === "citation_support" && result.modelFingerprint === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "citation support needs a model" });
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
    detail: z.string().min(1),
    obligationId: z.string().min(1).optional(),
    kind: ObligationKind.optional(),
    verifierId: z.string().min(1).optional(),
    violation: z.union([SandboxCapability, ForbiddenAction]).optional(),
  })
  .strict();
export type VerificationError = z.infer<typeof VerificationError>;
export const VerificationFact = z.union([VerificationResult, VerificationError]);
export type VerificationFact = z.infer<typeof VerificationFact>;

export interface Registry {
  verify(input: unknown): VerificationFact;
}
