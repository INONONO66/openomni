import { z } from "zod";
import {
  type Obligation,
  type VerificationError,
  JsonValue,
  VerificationError as VerificationErrorSchema,
} from "./verifier-registry-contract.js";
import { FrozenNliModelFingerprint } from "./verifier-frozen-nli-model.js";
import {
  type SandboxInstruction,
  type SandboxOutcome,
  executeSandboxInstruction,
} from "./verifier-sandbox.js";

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const SchemaInputs = z.object({ schema: z.literal("native_tool_call"), value: JsonValue }).strict();
const NumericInputs = z
  .object({
    operator: z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]),
    left: z.number().finite(),
    right: z.number().finite(),
  })
  .strict();
const CodeInputs = z
  .object({
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    operands: z.tuple([z.number().finite(), z.number().finite()]),
    expected: z.number().finite(),
  })
  .strict()
  .refine(
    (input) => input.operation !== "divide" || input.operands[1] !== 0,
    "division by zero is not a replayable code predicate",
  );
const ArchivedInputs = z
  .object({
    target: z.string().url(),
    observedStatus: z.number().int().min(100).max(599),
    expectedStatus: z.number().int().min(100).max(599),
    observedDigest: Digest.optional(),
    expectedDigest: Digest.optional(),
  })
  .strict();
const ApiInputs = ArchivedInputs.extend({ method: z.enum(["GET", "HEAD"]) }).strict();
const HashInputs = z
  .object({ algorithm: z.literal("sha256"), value: JsonValue, expectedDigest: Digest })
  .strict();
const QuoteInputs = z
  .object({
    archivedText: z.string().min(1).max(1_048_576),
    quotedText: z.string().min(1).max(1_048_576),
  })
  .strict();
const CitationInputs = z
  .object({
    archivedText: z.string().min(1).max(1_048_576),
  })
  .strict();

export type Evaluation = SandboxOutcome &
  Readonly<{
    verifierId: string;
    modelFingerprint?: string;
  }>;

export type CompiledObligation = Readonly<{
  verifierId: string;
  instruction: SandboxInstruction;
  modelFingerprint?: string;
}>;

export function evaluateObligation(obligation: Obligation): Evaluation | VerificationError {
  const compiled = compileObligation(obligation);
  if ("type" in compiled) return compiled;
  return {
    verifierId: compiled.verifierId,
    ...executeSandboxInstruction(compiled.instruction),
    modelFingerprint: compiled.modelFingerprint,
  };
}

export function compileObligation(obligation: Obligation): CompiledObligation | VerificationError {
  switch (obligation.kind) {
    case "schema_validity": {
      const input = SchemaInputs.safeParse(obligation.recordedInputs);
      return input.success
        ? compiled("builtin.schema-v1", { op: "native_schema", value: input.data.value })
        : invalidInputs(obligation, "builtin.schema-v1");
    }
    case "numeric_recheck": {
      const input = NumericInputs.safeParse(obligation.recordedInputs);
      return input.success
        ? compiled("builtin.numeric-v1", { op: "numeric_compare", ...input.data })
        : invalidInputs(obligation, "builtin.numeric-v1");
    }
    case "code_recheck": {
      const input = CodeInputs.safeParse(obligation.recordedInputs);
      if (!input.success) return invalidInputs(obligation, "builtin.code-v1");
      return compiled("builtin.code-v1", {
        op: "code_arithmetic",
        operation: input.data.operation,
        left: input.data.operands[0],
        right: input.data.operands[1],
        expected: input.data.expected,
      });
    }
    case "archived_url_recheck":
      return compileArchive(obligation, false);
    case "archived_api_recheck":
      return compileArchive(obligation, true);
    case "hash_recheck": {
      const input = HashInputs.safeParse(obligation.recordedInputs);
      return input.success
        ? compiled("builtin.hash-v1", {
            op: "hash_compare",
            value: input.data.value,
            expectedDigest: input.data.expectedDigest,
          })
        : invalidInputs(obligation, "builtin.hash-v1");
    }
    case "archived_quote_match": {
      const input = QuoteInputs.safeParse(obligation.recordedInputs);
      return input.success
        ? compiled("builtin.archived-quote-v1", { op: "quote_match", ...input.data })
        : invalidInputs(obligation, "builtin.archived-quote-v1");
    }
    case "citation_support": {
      const input = CitationInputs.safeParse(obligation.recordedInputs);
      return input.success
        ? compiled(
            "builtin.frozen-symbolic-nli-v1",
            {
              op: "citation_support",
              archivedText: input.data.archivedText,
              claimText: obligation.claim,
            },
            FrozenNliModelFingerprint,
          )
        : invalidInputs(obligation, "builtin.frozen-symbolic-nli-v1");
    }
    default:
      return invalidInputs(obligation, "builtin.unreachable");
  }
}

function compileArchive(
  obligation: Obligation,
  api: boolean,
): CompiledObligation | VerificationError {
  const verifierId = api ? "builtin.archived-api-v1" : "builtin.archived-url-v1";
  if (api) {
    const input = ApiInputs.safeParse(obligation.recordedInputs);
    if (!input.success) return invalidInputs(obligation, verifierId);
    return compiled(verifierId, {
      op: "archive_compare",
      target: input.data.target,
      method: input.data.method,
      observedStatus: input.data.observedStatus,
      expectedStatus: input.data.expectedStatus,
      observedDigest: input.data.observedDigest,
      expectedDigest: input.data.expectedDigest,
    });
  }
  const input = ArchivedInputs.safeParse(obligation.recordedInputs);
  if (!input.success) return invalidInputs(obligation, verifierId);
  return compiled(verifierId, {
    op: "archive_compare",
    target: input.data.target,
    observedStatus: input.data.observedStatus,
    expectedStatus: input.data.expectedStatus,
    observedDigest: input.data.observedDigest,
    expectedDigest: input.data.expectedDigest,
  });
}

function compiled(
  verifierId: string,
  instruction: SandboxInstruction,
  modelFingerprint?: string,
): CompiledObligation {
  return { verifierId, instruction, modelFingerprint };
}

function invalidInputs(obligation: Obligation, verifierId: string): VerificationError {
  return Object.freeze(
    VerificationErrorSchema.parse({
      type: "verification_error",
      code: "malformed_input",
      detail: "recorded inputs failed built-in verifier schema",
      obligationId: obligation.obligationId,
      kind: obligation.kind,
      verifierId,
    }),
  );
}
