import { z } from "zod";
import {
  type JsonObject as CanonicalJsonObject,
  type JsonValue as CanonicalJsonValue,
  JsonObjectSchema,
  JsonValueSchema,
  Sha256DigestSchema,
  snapshotFirstJsonSchema,
  snapshotJsonValue,
} from "./verifier-conformance-canonical.js";

const obligationKinds = [
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
] as const;

const assertedOnlyKinds = [
  "reasoning",
  "subjective",
  "creative",
  "opinion",
  "prediction",
  "normative_ethical",
  "out_of_archive",
] as const;

export function createVerifierRegistrySchemas(isolateCanonicalSchemas = false) {
  const ObligationKind = z.enum(obligationKinds);
  const AssertedOnlyKind = z.enum(assertedOnlyKinds);
  const ResultStatus = z.enum(["verified", "refuted", "inconclusive", "asserted"]);
  const SandboxCapability = z.enum(["network", "clock", "subprocess", "live_llm", "device"]);
  const ForbiddenAction = z.enum([
    "session_import",
    "persist",
    "admit",
    "complete",
    "fold",
    "effect",
    "replay",
  ]);
  const JsonValue = isolateCanonicalSchemas
    ? snapshotFirstJsonSchema(
        z.unknown().transform<CanonicalJsonValue>((value, context) => {
          try {
            return snapshotJsonValue(value);
          } catch {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "expected bounded plain JSON value",
            });
            return z.NEVER;
          }
        }),
      )
    : JsonValueSchema;
  const JsonObject = isolateCanonicalSchemas
    ? snapshotFirstJsonSchema(
        z.unknown().transform<CanonicalJsonObject>((value, context) => {
          try {
            const snapshot = snapshotJsonValue(value);
            if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
              throw new Error("expected JSON object");
            }
            return snapshot as CanonicalJsonObject;
          } catch {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "expected bounded plain JSON object",
            });
            return z.NEVER;
          }
        }),
      )
    : JsonObjectSchema;
  const Sha256Digest = isolateCanonicalSchemas
    ? snapshotFirstJsonSchema(z.string().regex(/^sha256:[a-f0-9]{64}$/))
    : Sha256DigestSchema;
  const Obligation = z
    .object({
      obligationId: z.string().min(1).max(512),
      kind: ObligationKind,
      claim: z.string().min(1).max(65_536),
      recordedInputs: JsonObject,
    })
    .strict();
  const VerifierProgram = z
    .object({
      version: z.literal("verifier-program-v1"),
      outputVersion: z.string().min(1).max(256),
      capabilities: z.array(SandboxCapability).max(SandboxCapability.options.length),
      actions: z.array(ForbiddenAction).max(ForbiddenAction.options.length),
    })
    .strict();
  const VerificationRequest = z
    .object({ obligation: Obligation, program: VerifierProgram })
    .strict();
  const VerificationResult = z
    .object({
      type: z.literal("verification_result"),
      obligationId: z.string().min(1).max(512),
      kind: ObligationKind,
      verifierId: z.string().min(1).max(256),
      status: ResultStatus,
      basisHash: Sha256Digest,
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
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "citation support needs a model",
        });
      }
      if (result.kind !== "citation_support" && result.modelFingerprint !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "only citation support carries a model fingerprint",
        });
      }
    });
  const VerificationErrorCode = z.enum([
    "malformed_input",
    "malformed_output",
    "verifier_crash",
    "prohibited_capability",
    "forbidden_action",
  ]);
  const VerificationError = z
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
  const VerificationFact = z.union([VerificationResult, VerificationError]);

  return {
    ObligationKind,
    AssertedOnlyKind,
    ResultStatus,
    SandboxCapability,
    ForbiddenAction,
    JsonValue,
    Obligation,
    VerifierProgram,
    VerificationRequest,
    VerificationResult,
    VerificationErrorCode,
    VerificationError,
    VerificationFact,
  };
}

const schemas = createVerifierRegistrySchemas();

export const ObligationKind = schemas.ObligationKind;
export type ObligationKind = z.infer<typeof ObligationKind>;
export const AssertedOnlyKind = schemas.AssertedOnlyKind;
export type AssertedOnlyKind = z.infer<typeof AssertedOnlyKind>;
export const ResultStatus = schemas.ResultStatus;
export type ResultStatus = z.infer<typeof ResultStatus>;
export const SandboxCapability = schemas.SandboxCapability;
export type SandboxCapability = z.infer<typeof SandboxCapability>;
export const ForbiddenAction = schemas.ForbiddenAction;
export type ForbiddenAction = z.infer<typeof ForbiddenAction>;
export const JsonValue = schemas.JsonValue;
export type JsonValue = CanonicalJsonValue;
export const Obligation = schemas.Obligation;
export type Obligation = z.infer<typeof Obligation>;
export const VerifierProgram = schemas.VerifierProgram;
export type VerifierProgram = z.infer<typeof VerifierProgram>;
export const VerificationRequest = schemas.VerificationRequest;
export type VerificationRequest = z.infer<typeof VerificationRequest>;
export const VerificationResult = schemas.VerificationResult;
export type VerificationResult = z.infer<typeof VerificationResult>;
export const VerificationErrorCode = schemas.VerificationErrorCode;
export type VerificationErrorCode = z.infer<typeof VerificationErrorCode>;
export const VerificationError = schemas.VerificationError;
export type VerificationError = z.infer<typeof VerificationError>;
export const VerificationFact = schemas.VerificationFact;
export type VerificationFact = z.infer<typeof VerificationFact>;

export interface Registry {
  verify(input: unknown): VerificationFact;
}
