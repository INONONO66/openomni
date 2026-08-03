import { createHash } from "node:crypto";
import { Tool } from "@openomni/protocol";
import { z } from "zod";
import { canonicalJson } from "./verifier-conformance-canonical.js";
import {
  type Obligation,
  type ResultStatus,
  type VerificationError,
  JsonValue,
  VerificationError as VerificationErrorSchema,
} from "./verifier-registry-contract.js";
import {
  FrozenNliModelFingerprint,
  frozenSymbolicNliSupports,
} from "./verifier-frozen-nli-model.js";

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
  .strict();
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
  .object({ archivedText: z.string().min(1), quotedText: z.string().min(1) })
  .strict();
const CitationInputs = z
  .object({ archivedText: z.string().min(1), claimText: z.string().min(1) })
  .strict();

export type Evaluation = Readonly<{
  verifierId: string;
  status: ResultStatus;
  checkedPredicate?: string;
  modelFingerprint?: string;
}>;

export function evaluateObligation(obligation: Obligation): Evaluation | VerificationError {
  switch (obligation.kind) {
    case "schema_validity":
      return schemaValidity(obligation);
    case "numeric_recheck":
      return numeric(obligation);
    case "code_recheck":
      return code(obligation);
    case "archived_url_recheck":
      return archived(obligation, false);
    case "archived_api_recheck":
      return archived(obligation, true);
    case "hash_recheck":
      return hash(obligation);
    case "archived_quote_match":
      return quote(obligation);
    case "citation_support":
      return citation(obligation);
    default:
      return invalidInputs(obligation, "builtin.unreachable");
  }
}

function schemaValidity(obligation: Obligation): Evaluation | VerificationError {
  const input = SchemaInputs.safeParse(obligation.recordedInputs);
  if (!input.success) return invalidInputs(obligation, "builtin.schema-v1");
  return evaluation(
    "builtin.schema-v1",
    Tool.Call.safeParse(input.data.value).success,
    "recorded value satisfies the native Tool.Call schema",
  );
}

function numeric(obligation: Obligation): Evaluation | VerificationError {
  const input = NumericInputs.safeParse(obligation.recordedInputs);
  if (!input.success) return invalidInputs(obligation, "builtin.numeric-v1");
  const { left, operator, right } = input.data;
  const passed =
    operator === "eq"
      ? left === right
      : operator === "neq"
        ? left !== right
        : operator === "lt"
          ? left < right
          : operator === "lte"
            ? left <= right
            : operator === "gt"
              ? left > right
              : left >= right;
  return evaluation("builtin.numeric-v1", passed, `recorded numeric operands satisfy ${operator}`);
}

function code(obligation: Obligation): Evaluation | VerificationError {
  const input = CodeInputs.safeParse(obligation.recordedInputs);
  if (!input.success) return invalidInputs(obligation, "builtin.code-v1");
  const [left, right] = input.data.operands;
  if (input.data.operation === "divide" && right === 0) throw new Error("division by zero");
  const actual =
    input.data.operation === "add"
      ? left + right
      : input.data.operation === "subtract"
        ? left - right
        : input.data.operation === "multiply"
          ? left * right
          : left / right;
  return evaluation(
    "builtin.code-v1",
    actual === input.data.expected,
    `recorded ${input.data.operation} program yields expected output`,
  );
}

function archived(obligation: Obligation, api: boolean): Evaluation | VerificationError {
  const input = (api ? ApiInputs : ArchivedInputs).safeParse(obligation.recordedInputs);
  const verifierId = api ? "builtin.archived-api-v1" : "builtin.archived-url-v1";
  if (!input.success) return invalidInputs(obligation, verifierId);
  const digestMatches =
    input.data.expectedDigest === undefined ||
    input.data.observedDigest === input.data.expectedDigest;
  return evaluation(
    verifierId,
    input.data.observedStatus === input.data.expectedStatus && digestMatches,
    "recorded archive status and optional digest equal the expected read-back predicate",
  );
}

function hash(obligation: Obligation): Evaluation | VerificationError {
  const input = HashInputs.safeParse(obligation.recordedInputs);
  if (!input.success) return invalidInputs(obligation, "builtin.hash-v1");
  const actual = `sha256:${createHash("sha256").update(canonicalJson(input.data.value)).digest("hex")}`;
  return evaluation(
    "builtin.hash-v1",
    actual === input.data.expectedDigest,
    "SHA-256 over canonical recorded input equals the expected digest",
  );
}

function quote(obligation: Obligation): Evaluation | VerificationError {
  const input = QuoteInputs.safeParse(obligation.recordedInputs);
  if (!input.success) return invalidInputs(obligation, "builtin.archived-quote-v1");
  return evaluation(
    "builtin.archived-quote-v1",
    input.data.archivedText.includes(input.data.quotedText),
    "archived source contains the recorded quote exactly",
  );
}

function citation(obligation: Obligation): Evaluation | VerificationError {
  const input = CitationInputs.safeParse(obligation.recordedInputs);
  if (!input.success) return invalidInputs(obligation, "builtin.frozen-symbolic-nli-v1");
  return {
    ...evaluation(
      "builtin.frozen-symbolic-nli-v1",
      frozenSymbolicNliSupports(input.data.archivedText, input.data.claimText),
      "frozen symbolic NLI and lexical overlap with exact numeric agreement support the citation",
    ),
    modelFingerprint: FrozenNliModelFingerprint,
  };
}

function evaluation(verifierId: string, passed: boolean, checkedPredicate: string): Evaluation {
  return {
    verifierId,
    status: passed ? "verified" : "refuted",
    checkedPredicate,
  };
}

function invalidInputs(obligation: Obligation, verifierId: string): VerificationError {
  return VerificationErrorSchema.parse({
    type: "verification_error",
    code: "malformed_input",
    detail: "recorded inputs failed built-in verifier schema",
    obligationId: obligation.obligationId,
    kind: obligation.kind,
    verifierId,
  });
}
