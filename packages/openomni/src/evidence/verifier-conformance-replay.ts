import { z } from "zod";
import {
  JsonValueSchema,
  RedactedIdentifierSchema,
  Sha256DigestSchema,
  canonicalJson,
  freezeJson,
  hashCanonicalJson,
  type JsonValue,
} from "./verifier-conformance-canonical.js";

const ArchivedRangeSchema = z
  .object({
    kind: z.literal("range"),
    archiveIdentifier: RedactedIdentifierSchema,
    fromSequence: z.number().int().nonnegative(),
    toSequence: z.number().int().nonnegative(),
  })
  .strict()
  .refine((range) => range.toSequence >= range.fromSequence, "archive range is reversed");
const ArchivedCassetteSchema = z
  .object({
    kind: z.literal("cassette"),
    cassetteIdentifier: RedactedIdentifierSchema,
    digest: Sha256DigestSchema,
  })
  .strict();

export const ReplayBindingSchema = z
  .object({
    version: z.literal("replay-key-v1"),
    source: z.union([ArchivedRangeSchema, ArchivedCassetteSchema]),
    environmentFingerprint: Sha256DigestSchema,
    schemaVersion: z.string().min(1),
    upcastVersion: z.string().min(1),
    nondeterminismManifestHash: Sha256DigestSchema,
  })
  .strict();
export const ReplayKeySchema = ReplayBindingSchema.extend({
  replayKey: Sha256DigestSchema,
}).strict();
type ReplayKeyShape = z.infer<typeof ReplayKeySchema>;
export type ReplayKey = Readonly<Omit<ReplayKeyShape, "source">> & {
  readonly source: Readonly<ReplayKeyShape["source"]>;
};

export function createReplayKey(input: unknown): ReplayKey {
  const binding = ReplayBindingSchema.parse(input);
  const key = ReplayKeySchema.parse({ ...binding, replayKey: hashCanonicalJson(binding) });
  Object.freeze(key.source);
  return Object.freeze(key);
}

export const ReplayTraceSchema = z
  .object({ commands: z.array(JsonValueSchema), finalFold: JsonValueSchema })
  .strict();
export const ReplayDivergenceSchema = z
  .object({
    version: z.literal("replay-divergence-v1"),
    kind: z.enum([
      "missing_command",
      "unexpected_command",
      "command_mismatch",
      "final_fold_mismatch",
      "interleaving_mismatch",
    ]),
    index: z.number().int().nonnegative().optional(),
    expectedHash: Sha256DigestSchema.optional(),
    actualHash: Sha256DigestSchema.optional(),
    seed: z.number().int().optional(),
    iteration: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ReplayDivergence = Readonly<z.infer<typeof ReplayDivergenceSchema>>;

export class ReplayConformanceError extends Error {
  constructor(readonly facts: ReplayDivergence) {
    const location = facts.index === undefined ? "" : ` at command ${facts.index}`;
    super(`Replay conformance failed: ${facts.kind}${location}`);
    this.name = "ReplayConformanceError";
  }
}

export function failReplayConformance(facts: ReplayDivergence): never {
  throw new ReplayConformanceError(Object.freeze(ReplayDivergenceSchema.parse(facts)));
}

export function assertReplayConformance(expectedInput: unknown, actualInput: unknown): void {
  const expected = ReplayTraceSchema.parse(expectedInput);
  const actual = ReplayTraceSchema.parse(actualInput);
  const shared = Math.min(expected.commands.length, actual.commands.length);
  for (let index = 0; index < shared; index += 1) {
    const expectedCommand = expected.commands[index];
    const actualCommand = actual.commands[index];
    if (expectedCommand === undefined || actualCommand === undefined) {
      throw new Error("invalid command index");
    }
    if (canonicalJson(expectedCommand) !== canonicalJson(actualCommand)) {
      failReplayConformance({
        version: "replay-divergence-v1",
        kind: "command_mismatch",
        index,
        expectedHash: hashCanonicalJson(expectedCommand),
        actualHash: hashCanonicalJson(actualCommand),
      });
    }
  }
  if (expected.commands.length > shared) {
    const command = expected.commands[shared];
    if (command === undefined) throw new Error("invalid expected command index");
    failReplayConformance({
      version: "replay-divergence-v1",
      kind: "missing_command",
      index: shared,
      expectedHash: hashCanonicalJson(command),
    });
  }
  if (actual.commands.length > shared) {
    const command = actual.commands[shared];
    if (command === undefined) throw new Error("invalid actual command index");
    failReplayConformance({
      version: "replay-divergence-v1",
      kind: "unexpected_command",
      index: shared,
      actualHash: hashCanonicalJson(command),
    });
  }
  if (canonicalJson(expected.finalFold) !== canonicalJson(actual.finalFold)) {
    failReplayConformance({
      version: "replay-divergence-v1",
      kind: "final_fold_mismatch",
      expectedHash: hashCanonicalJson(expected.finalFold),
      actualHash: hashCanonicalJson(actual.finalFold),
    });
  }
}

export const RecordedCommandSchema = z
  .object({ command: JsonValueSchema, output: JsonValueSchema })
  .strict();
type RecordedCommandShape = z.infer<typeof RecordedCommandSchema>;
export type RecordedCommand = Readonly<RecordedCommandShape>;

export function substituteRecordedOutputs(
  commandInputs: readonly JsonValue[],
  cassetteInputs: readonly RecordedCommand[],
): readonly JsonValue[] {
  const commands = z.array(JsonValueSchema).parse(commandInputs);
  const cassette = z.array(RecordedCommandSchema).parse(cassetteInputs);
  const shared = Math.min(commands.length, cassette.length);
  const outputs: JsonValue[] = [];
  for (let index = 0; index < shared; index += 1) {
    const command = commands[index];
    const recorded = cassette[index];
    if (command === undefined || recorded === undefined) throw new Error("invalid cassette index");
    if (canonicalJson(command) !== canonicalJson(recorded.command)) {
      failReplayConformance({
        version: "replay-divergence-v1",
        kind: "command_mismatch",
        index,
        expectedHash: hashCanonicalJson(recorded.command),
        actualHash: hashCanonicalJson(command),
      });
    }
    const cloned = JsonValueSchema.parse(JSON.parse(canonicalJson(recorded.output)));
    outputs.push(freezeJson(cloned));
  }
  if (cassette.length > shared) {
    const recorded = cassette[shared];
    if (recorded === undefined) throw new Error("invalid recorded command index");
    failReplayConformance({
      version: "replay-divergence-v1",
      kind: "missing_command",
      index: shared,
      expectedHash: hashCanonicalJson(recorded.command),
    });
  }
  if (commands.length > shared) {
    const command = commands[shared];
    if (command === undefined) throw new Error("invalid replay command index");
    failReplayConformance({
      version: "replay-divergence-v1",
      kind: "unexpected_command",
      index: shared,
      actualHash: hashCanonicalJson(command),
    });
  }
  return Object.freeze(outputs);
}
