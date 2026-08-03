import { createHash } from "node:crypto";
import { Tool } from "@openomni/protocol";
import { z } from "zod";
import {
  JsonValueSchema,
  Sha256DigestSchema,
  canonicalJson,
} from "./verifier-conformance-canonical.js";
import { frozenSymbolicNliInfer } from "./verifier-frozen-nli-model.js";

const NativeSchemaInstruction = z
  .object({ op: z.literal("native_schema"), value: JsonValueSchema })
  .strict();
const NumericInstruction = z
  .object({
    op: z.literal("numeric_compare"),
    operator: z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]),
    left: z.number().finite(),
    right: z.number().finite(),
  })
  .strict();
const CodeInstruction = z
  .object({
    op: z.literal("code_arithmetic"),
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    left: z.number().finite(),
    right: z.number().finite(),
    expected: z.number().finite(),
  })
  .strict();
const ArchiveInstruction = z
  .object({
    op: z.literal("archive_compare"),
    target: z
      .string()
      .url()
      .regex(/^https?:\/\//u),
    method: z.enum(["GET", "HEAD"]).optional(),
    observedStatus: z.number().int().min(100).max(599),
    expectedStatus: z.number().int().min(100).max(599),
    observedDigest: Sha256DigestSchema.optional(),
    expectedDigest: Sha256DigestSchema.optional(),
  })
  .strict();
const HashInstruction = z
  .object({
    op: z.literal("hash_compare"),
    value: JsonValueSchema,
    expectedDigest: Sha256DigestSchema,
  })
  .strict();
const QuoteInstruction = z
  .object({
    op: z.literal("quote_match"),
    archivedText: z.string().min(1).max(1_048_576),
    quotedText: z.string().min(1).max(1_048_576),
  })
  .strict();
const CitationInstruction = z
  .object({
    op: z.literal("citation_support"),
    archivedText: z.string().min(1).max(1_048_576),
    claimText: z.string().min(1).max(65_536),
  })
  .strict();

export const SandboxInstruction = z.discriminatedUnion("op", [
  NativeSchemaInstruction,
  NumericInstruction,
  CodeInstruction,
  ArchiveInstruction,
  HashInstruction,
  QuoteInstruction,
  CitationInstruction,
]);
export type SandboxInstruction = Readonly<z.infer<typeof SandboxInstruction>>;

export type SandboxOutcome = Readonly<{
  status: "verified" | "refuted" | "inconclusive";
  checkedPredicate: string;
}>;

export function executeSandboxInstruction(input: unknown): SandboxOutcome {
  const instruction = SandboxInstruction.parse(input);
  switch (instruction.op) {
    case "native_schema":
      return nativeSchema(instruction);
    case "numeric_compare":
      return numericCompare(instruction);
    case "code_arithmetic":
      return codeArithmetic(instruction);
    case "archive_compare":
      return archiveCompare(instruction);
    case "hash_compare":
      return outcome(
        hashCanonical(instruction.value) === instruction.expectedDigest,
        "SHA-256 over canonical recorded input equals the expected digest",
      );
    case "quote_match":
      return outcome(
        instruction.archivedText.includes(instruction.quotedText),
        "archived source contains the recorded quote exactly",
      );
    case "citation_support": {
      const relation = frozenSymbolicNliInfer(instruction.archivedText, instruction.claimText);
      return {
        status:
          relation === "entails"
            ? "verified"
            : relation === "contradicts"
              ? "refuted"
              : "inconclusive",
        checkedPredicate:
          "frozen symbolic NLI relation and directional lexical support agree with the citation",
      };
    }
  }
}

function nativeSchema(instruction: z.infer<typeof NativeSchemaInstruction>): SandboxOutcome {
  const parsed = Tool.Call.safeParse(instruction.value);
  return outcome(
    parsed.success && canonicalJson(parsed.data) === canonicalJson(instruction.value),
    "recorded value exactly satisfies the native Tool.Call schema without dropped fields",
  );
}

function numericCompare(instruction: z.infer<typeof NumericInstruction>): SandboxOutcome {
  const { left, operator, right } = instruction;
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
  return outcome(passed, `recorded numeric operands satisfy ${operator}`);
}

function codeArithmetic(instruction: z.infer<typeof CodeInstruction>): SandboxOutcome {
  if (instruction.operation === "divide" && instruction.right === 0) {
    throw new Error("division by zero");
  }
  const actual =
    instruction.operation === "add"
      ? instruction.left + instruction.right
      : instruction.operation === "subtract"
        ? instruction.left - instruction.right
        : instruction.operation === "multiply"
          ? instruction.left * instruction.right
          : instruction.left / instruction.right;
  return outcome(
    actual === instruction.expected,
    `recorded ${instruction.operation} program yields expected output`,
  );
}

function archiveCompare(instruction: z.infer<typeof ArchiveInstruction>): SandboxOutcome {
  if (instruction.observedStatus !== instruction.expectedStatus) {
    return outcome(false, "recorded archive status equals the expected read-back status");
  }
  if (instruction.expectedDigest === undefined) {
    return outcome(true, "recorded archive status equals the expected read-back status");
  }
  if (instruction.observedDigest === undefined) {
    return {
      status: "inconclusive",
      checkedPredicate: "expected archive digest was not available in the recorded observation",
    };
  }
  return outcome(
    instruction.observedDigest === instruction.expectedDigest,
    "recorded archive status and digest equal the expected read-back predicate",
  );
}

function hashCanonical(value: z.infer<typeof JsonValueSchema>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function outcome(passed: boolean, checkedPredicate: string): SandboxOutcome {
  return { status: passed ? "verified" : "refuted", checkedPredicate };
}
