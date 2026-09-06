import {
  canonicalDigest,
  NamedError,
  type PlainObject,
  type PlainValue,
  PlainValueSchema,
  Policy,
  type PolicyRow,
  type Storage,
} from "@openomni/protocol";
import { z } from "zod";

const MANDATORY_RULE_NAMES = ["compaction"] as const;
export type RuleName = (typeof MANDATORY_RULE_NAMES)[number];

const TRANSFORMER_NAMES = ["redact"] as const;
const OBLIGATION_NAMES = ["budget_clamp"] as const;
type ObligationName = (typeof OBLIGATION_NAMES)[number];

const CORE_ACTION_KINDS = ["prompt", "turn", "llm", "tool"] as const;

const CompileErrorCode = z.enum([
  "generation_mismatch",
  "mandatory_rule_missing",
  "unknown_kind",
  "invalid_match",
  "invalid_verdict",
  "unknown_transformer",
  "unknown_obligation",
  "snapshot_load_failed",
  "snapshot_append_failed",
]);
export type PolicyCompileErrorCode = z.infer<typeof CompileErrorCode>;

const CompileErrorData = z
  .object({
    code: CompileErrorCode,
    generation: z.number().int().nonnegative(),
    message: z.string(),
    ruleName: z.string().optional(),
    kind: z.string().optional(),
    phase: z.enum(["pre", "post"]).optional(),
    name: z.string().optional(),
  })
  .strict();

const PolicyCompileErrorBase = NamedError.create("PolicyCompileError", CompileErrorData);

type CompileErrorOptions = Omit<z.input<typeof CompileErrorData>, "message"> & {
  readonly message?: string;
};

export class PolicyCompileError extends PolicyCompileErrorBase {
  constructor(options: CompileErrorOptions) {
    super({
      ...options,
      message: options.message ?? compileErrorMessage(options),
    });
  }

  get code(): PolicyCompileErrorCode {
    return this.data.code;
  }

  get generation(): number {
    return this.data.generation;
  }

  get ruleName(): string | undefined {
    return this.data.ruleName;
  }
}

function compileErrorMessage(options: CompileErrorOptions): string {
  switch (options.code) {
    case "generation_mismatch":
      return `policy row ${options.ruleName ?? "<unnamed>"} does not belong to generation ${options.generation}`;
    case "mandatory_rule_missing":
      return `policy generation ${options.generation} is missing mandatory rule ${options.ruleName ?? "<unnamed>"}`;
    case "unknown_kind":
      return `policy rule ${options.ruleName ?? "<unnamed>"} references unregistered kind ${options.kind ?? "<missing>"}`;
    case "invalid_match":
      return `policy rule ${options.ruleName ?? "<unnamed>"} has an invalid match`;
    case "invalid_verdict":
      return `policy rule ${options.ruleName ?? "<unnamed>"} has an invalid verdict`;
    case "unknown_transformer":
      return `policy rule ${options.ruleName ?? "<unnamed>"} references unregistered transformer ${options.name ?? "<missing>"}`;
    case "unknown_obligation":
      return `policy rule ${options.ruleName ?? "<unnamed>"} references unregistered obligation ${options.name ?? "<missing>"}`;
    case "snapshot_load_failed":
      return `policy generation ${options.generation} could not be loaded`;
    case "snapshot_append_failed":
      return `policy generation ${options.generation} could not be appended`;
  }
}

const Match = z
  .object({
    op: z.string().min(1).optional(),
    role: z.enum(["resident", "worker"]).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();
type Match = z.infer<typeof Match>;

const AllowVerdict = z
  .object({
    type: z.literal("allow"),
    reason: z.string().optional(),
    reasonCodes: z.array(z.string()).optional(),
    effects: z
      .array(z.custom<Policy.PolicyEffect>((value) => Policy.PolicyEffect.safeParse(value).success))
      .optional(),
  })
  .strict();
const DenyVerdict = z
  .object({
    type: z.literal("deny"),
    reason: z.string().optional(),
  })
  .strict();
const ApprovalVerdict = z
  .object({
    type: z.literal("require_approval"),
    reason: z.string().min(1),
  })
  .strict();
const TransformVerdict = z
  .object({
    type: z.literal("transform"),
    name: z.enum(TRANSFORMER_NAMES),
    paths: z.array(z.string().min(1)).default([]),
    replacement: PlainValueSchema.optional(),
  })
  .strict();
const ObligationVerdict = z
  .object({
    type: z.literal("obligation"),
    name: z.enum(OBLIGATION_NAMES),
    metric: z.enum([
      "continuation",
      "fanout",
      "exact_repeat",
      "toolless_stall",
      "blocked_recurrence",
      "resume",
      "notifications",
    ]),
    limit: z.number().int().positive(),
  })
  .strict();
const RowVerdict = z.discriminatedUnion("type", [
  AllowVerdict,
  DenyVerdict,
  ApprovalVerdict,
  TransformVerdict,
  ObligationVerdict,
]);
type RowVerdict = z.infer<typeof RowVerdict>;

export interface PolicyEvaluationInput {
  readonly kind: string;
  readonly phase: PolicyRow.Phase;
  readonly op?: string;
  readonly role?: "resident" | "worker";
  readonly sessionId?: string;
  readonly value: PlainValue;
}

interface CompiledObligation {
  readonly name: ObligationName;
  readonly metric: z.infer<typeof ObligationVerdict>["metric"];
  readonly limit: number;
}

type EffectiveRowVerdict =
  | "allow"
  | "deny"
  | "require_approval"
  | "transform"
  | "obligation";

export interface PolicyEvaluation {
  readonly generation: number;
  readonly snapshotHash: string;
  readonly inputHash: string;
  readonly matchedRuleIds: readonly string[];
  readonly verdict: EffectiveRowVerdict;
  readonly reason?: string;
  readonly value: PlainValue;
  readonly effects: readonly Policy.PolicyEffect[];
  readonly obligations: readonly CompiledObligation[];
  readonly bucket: string;
  readonly evaluatedRuleCount: number;
  readonly error?: Readonly<z.infer<typeof CompileErrorData>>;
}

export interface CompiledPolicySnapshot {
  readonly generation: number;
  readonly contentHash: string;
  evaluate(input: PolicyEvaluationInput): PolicyEvaluation;
}

interface CompiledRow {
  readonly name: string;
  readonly kind: string;
  readonly phase: PolicyRow.Phase;
  readonly priority: number;
  readonly match: Match;
  readonly verdict: RowVerdict;
}

interface BucketSet {
  readonly wildcard: readonly CompiledRow[];
  readonly operations: ReadonlyMap<string, readonly CompiledRow[]>;
}

export interface CompilePolicySnapshotOptions {
  readonly generation: number;
  readonly rows: readonly PolicyRow.Row[];
  readonly mandatory?: readonly RuleName[];
  readonly kinds?: readonly string[];
}

const DEFAULT_COMPILE_KINDS = [...CORE_ACTION_KINDS, "session.configure"] as const;

function rowKey(row: Pick<PolicyRow.Row, "name" | "kind" | "phase">): string {
  return `${row.name}\u0000${row.kind}\u0000${row.phase}`;
}

function pointKey(kind: string, phase: PolicyRow.Phase): string {
  return `${kind}\u0000${phase}`;
}

function publicBucket(kind: string, phase: PolicyRow.Phase, op: string | undefined): string {
  return `${kind}/${phase}/${op ?? "*"}`;
}

function ordered(rows: readonly CompiledRow[]): readonly CompiledRow[] {
  return Object.freeze(
    [...rows].sort(
      (left, right) => right.priority - left.priority || left.name.localeCompare(right.name),
    ),
  );
}

function parseRow(row: PolicyRow.Row, generation: number, kinds: ReadonlySet<string>): CompiledRow {
  if (row.generation !== generation) {
    throw new PolicyCompileError({
      code: "generation_mismatch",
      generation,
      ruleName: row.name,
      kind: row.kind,
      phase: row.phase,
    });
  }
  if (!kinds.has(row.kind)) {
    throw new PolicyCompileError({
      code: "unknown_kind",
      generation,
      ruleName: row.name,
      kind: row.kind,
      phase: row.phase,
    });
  }
  const match = Match.safeParse(row.match.value);
  if (!match.success) {
    throw new PolicyCompileError({
      code: "invalid_match",
      generation,
      ruleName: row.name,
      kind: row.kind,
      phase: row.phase,
    });
  }
  const verdict = RowVerdict.safeParse(row.verdict.value);
  if (!verdict.success) {
    const rawVerdict =
      row.verdict.value !== null &&
      typeof row.verdict.value === "object" &&
      !Array.isArray(row.verdict.value)
        ? row.verdict.value
        : undefined;
    const rawType = rawVerdict?.type;
    const rawName = rawVerdict?.name;
    if (
      rawType === "transform" &&
      typeof rawName === "string" &&
      !TRANSFORMER_NAMES.some((name) => name === rawName)
    ) {
      throw new PolicyCompileError({
        code: "unknown_transformer",
        generation,
        ruleName: row.name,
        kind: row.kind,
        phase: row.phase,
        name: rawName,
      });
    }
    if (
      rawType === "obligation" &&
      typeof rawName === "string" &&
      !OBLIGATION_NAMES.some((name) => name === rawName)
    ) {
      throw new PolicyCompileError({
        code: "unknown_obligation",
        generation,
        ruleName: row.name,
        kind: row.kind,
        phase: row.phase,
        name: rawName,
      });
    }
    throw new PolicyCompileError({
      code: "invalid_verdict",
      generation,
      ruleName: row.name,
      kind: row.kind,
      phase: row.phase,
    });
  }
  return Object.freeze({
    name: row.name,
    kind: row.kind,
    phase: row.phase,
    priority: row.priority,
    match: Object.freeze(match.data),
    verdict: Object.freeze(verdict.data),
  });
}

function contentIdentity(rows: readonly PolicyRow.Row[]): PlainValue {
  return [...rows]
    .sort((left, right) => rowKey(left).localeCompare(rowKey(right)))
    .map((row) => ({
      name: row.name,
      kind: row.kind,
      phase: row.phase,
      match: row.match,
      verdict: row.verdict,
      priority: row.priority,
    }));
}

function buildBuckets(rows: readonly CompiledRow[]): ReadonlyMap<string, BucketSet> {
  const grouped = new Map<string, CompiledRow[]>();
  for (const row of rows) {
    const key = pointKey(row.kind, row.phase);
    const entries = grouped.get(key) ?? [];
    entries.push(row);
    grouped.set(key, entries);
  }

  const buckets = new Map<string, BucketSet>();
  for (const [key, entries] of grouped) {
    const wildcard = entries.filter((entry) => entry.match.op === undefined);
    const operationNames = new Set(
      entries.flatMap((entry) => (entry.match.op === undefined ? [] : [entry.match.op])),
    );
    const operations = new Map<string, readonly CompiledRow[]>();
    for (const operation of operationNames) {
      operations.set(
        operation,
        ordered(
          entries.filter((entry) => entry.match.op === undefined || entry.match.op === operation),
        ),
      );
    }
    buckets.set(key, Object.freeze({ wildcard: ordered(wildcard), operations }));
  }
  return buckets;
}

function matches(row: CompiledRow, input: PolicyEvaluationInput): boolean {
  return (
    (row.match.role === undefined || row.match.role === input.role) &&
    (row.match.sessionId === undefined || row.match.sessionId === input.sessionId)
  );
}

function clonePlain(value: PlainValue): PlainValue {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value === null || typeof value !== "object") return value;
  const copy: PlainObject = {};
  for (const [key, item] of Object.entries(value)) copy[key] = clonePlain(item);
  return copy;
}

function redact(value: PlainValue, paths: readonly string[], replacement?: PlainValue): PlainValue {
  const output = clonePlain(value);
  for (const path of paths) {
    const fields = path.split(".");
    const leaf = fields.pop();
    if (leaf === undefined || leaf.length === 0) continue;
    let parent: PlainValue | undefined = output;
    for (const field of fields) {
      if (parent === null || Array.isArray(parent) || typeof parent !== "object") {
        parent = undefined;
        break;
      }
      parent = parent[field];
      if (parent === undefined) break;
    }
    if (
      parent === undefined ||
      parent === null ||
      Array.isArray(parent) ||
      typeof parent !== "object"
    ) {
      continue;
    }
    if (replacement === undefined) delete parent[leaf];
    else parent[leaf] = clonePlain(replacement);
  }
  return output;
}

function evaluateSnapshot(
  generation: number,
  contentHash: string,
  buckets: ReadonlyMap<string, BucketSet>,
  input: PolicyEvaluationInput,
): PolicyEvaluation {
  const point = buckets.get(pointKey(input.kind, input.phase));
  const bucket =
    input.op === undefined ? point?.wildcard : (point?.operations.get(input.op) ?? point?.wildcard);
  const selected = bucket ?? [];
  const matchedRuleIds: string[] = [];
  const effects: Policy.PolicyEffect[] = [];
  const obligations: CompiledObligation[] = [];
  let value = clonePlain(input.value);
  let verdict: EffectiveRowVerdict = "allow";
  let reason: string | undefined;

  for (const compiled of selected) {
    if (!matches(compiled, input)) continue;
    matchedRuleIds.push(compiled.name);
    const candidate = compiled.verdict;
    if (candidate.type === "deny") {
      verdict = "deny";
      reason = candidate.reason ?? "denied";
      break;
    }
    if (candidate.type === "require_approval") {
      verdict = "require_approval";
      reason = candidate.reason;
      break;
    }
    if (candidate.type === "transform") {
      verdict = "transform";
      value = redact(value, candidate.paths, candidate.replacement);
      continue;
    }
    if (candidate.type === "obligation") {
      if (verdict === "allow") verdict = "obligation";
      obligations.push({
        name: candidate.name,
        metric: candidate.metric,
        limit: candidate.limit,
      });
      continue;
    }
    effects.push(...(candidate.effects ?? []));
    reason ??= candidate.reason ?? candidate.reasonCodes?.[0];
  }

  return Object.freeze({
    generation,
    snapshotHash: contentHash,
    inputHash: canonicalDigest(input),
    matchedRuleIds: Object.freeze(matchedRuleIds),
    verdict,
    ...(reason === undefined ? {} : { reason }),
    value,
    effects: Object.freeze(effects),
    obligations: Object.freeze(obligations),
    bucket: publicBucket(input.kind, input.phase, input.op),
    evaluatedRuleCount: matchedRuleIds.length,
  });
}

export function compilePolicySnapshot(
  options: CompilePolicySnapshotOptions,
): CompiledPolicySnapshot {
  const mandatory = new Set([...MANDATORY_RULE_NAMES, ...(options.mandatory ?? [])]);
  for (const name of mandatory) {
    if (!options.rows.some((row) => row.name === name)) {
      throw new PolicyCompileError({
        code: "mandatory_rule_missing",
        generation: options.generation,
        ruleName: name,
      });
    }
  }
  const kinds = new Set(options.kinds ?? DEFAULT_COMPILE_KINDS);
  const rows = options.rows.map((row) => parseRow(row, options.generation, kinds));
  const contentHash = canonicalDigest(contentIdentity(options.rows));
  const buckets = buildBuckets(rows);
  return Object.freeze({
    generation: options.generation,
    contentHash,
    evaluate: (input: PolicyEvaluationInput) =>
      evaluateSnapshot(options.generation, contentHash, buckets, input),
  });
}

function failedSnapshot(error: PolicyCompileError): CompiledPolicySnapshot {
  const contentHash = canonicalDigest({ generation: error.generation, error: error.data });
  return Object.freeze({
    generation: error.generation,
    contentHash,
    evaluate(input: PolicyEvaluationInput) {
      return Object.freeze({
        generation: error.generation,
        snapshotHash: contentHash,
        inputHash: canonicalDigest(input),
        matchedRuleIds: Object.freeze([]),
        verdict: "deny",
        reason: error.code,
        value: clonePlain(input.value),
        effects: Object.freeze([]),
        obligations: Object.freeze([]),
        bucket: publicBucket(input.kind, input.phase, input.op),
        evaluatedRuleCount: 0,
        error: Object.freeze(error.data),
      });
    },
  });
}

export type PolicyRowDraft = Omit<PolicyRow.Row, "generation">;

export interface PolicyCompiler {
  pin(generation: number): CompiledPolicySnapshot;
  append(rows: readonly PolicyRowDraft[]): Promise<number>;
}

export function createPolicyCompiler(options: {
  readonly source: Storage.PolicyRowSubAdapter;
  readonly mandatory?: readonly RuleName[];
  readonly kinds?: readonly string[];
}): PolicyCompiler {
  const cache = new Map<number, CompiledPolicySnapshot>();
  const mandatory = options.mandatory ?? MANDATORY_RULE_NAMES;

  function pin(generation: number): CompiledPolicySnapshot {
    const found = cache.get(generation);
    if (found !== undefined) return found;
    let compiled: CompiledPolicySnapshot;
    try {
      compiled = compilePolicySnapshot({
        generation,
        rows: options.source.rows(generation),
        mandatory,
        ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
      });
    } catch (error) {
      const failure = PolicyCompileError.isInstance(error)
        ? error
        : new PolicyCompileError({
            code: "snapshot_load_failed",
            generation,
            message: "policy snapshot load failed",
          });
      compiled = failedSnapshot(failure);
    }
    cache.set(generation, compiled);
    return compiled;
  }

  async function append(drafts: readonly PolicyRowDraft[]): Promise<number> {
    let all: PolicyRow.Row[];
    try {
      all = options.source.rows();
    } catch {
      throw new PolicyCompileError({ code: "snapshot_load_failed", generation: 0 });
    }
    const currentGeneration = all.reduce((latest, row) => Math.max(latest, row.generation), 0);
    const generation = currentGeneration + 1;
    const next = new Map<string, PolicyRowDraft>();
    for (const row of all) {
      if (row.generation !== currentGeneration) continue;
      const { generation: _generation, ...draft } = row;
      next.set(rowKey(row), draft);
    }
    for (const draft of drafts) next.set(rowKey(draft), draft);
    const rows = [...next.values()].map((draft) => ({ ...draft, generation }));
    const compiled = compilePolicySnapshot({
      generation,
      rows,
      mandatory,
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    });
    for (const row of rows) {
      if (!options.source.append(row)) {
        throw new PolicyCompileError({
          code: "snapshot_append_failed",
          generation,
          ruleName: row.name,
          kind: row.kind,
          phase: row.phase,
        });
      }
    }
    cache.set(generation, compiled);
    return generation;
  }

  return { pin, append };
}

function seeded(
  name: string,
  kind: string,
  phase: PolicyRow.Phase,
  match: PlainValue,
  verdict: PlainValue,
  priority: number,
): PolicyRowDraft {
  return {
    name,
    kind,
    phase,
    match: { encodingVersion: 1, value: match },
    verdict: { encodingVersion: 1, value: verdict },
    priority,
  };
}

/** Kernel-owned initial data; the numeric limits are read from these rows. */
export const SEEDED_POLICY_ROWS: readonly PolicyRowDraft[] = Object.freeze([
  seeded("compaction", "turn", "post", { op: "compaction" }, { type: "allow" }, 1_000),
  seeded(
    "continuation-cap",
    "turn",
    "post",
    { op: "continue" },
    { type: "obligation", name: "budget_clamp", metric: "continuation", limit: 8 },
    900,
  ),
  seeded(
    "fanout-cap",
    "tool",
    "pre",
    { op: "sendMessage" },
    { type: "obligation", name: "budget_clamp", metric: "fanout", limit: 8 },
    900,
  ),
  seeded(
    "exact-repeat-cap",
    "turn",
    "post",
    { op: "exact_repeat" },
    { type: "obligation", name: "budget_clamp", metric: "exact_repeat", limit: 3 },
    900,
  ),
  seeded(
    "toolless-stall-cap",
    "turn",
    "post",
    { op: "toolless_stall" },
    { type: "obligation", name: "budget_clamp", metric: "toolless_stall", limit: 3 },
    900,
  ),
  seeded(
    "blocked-recurrence-cap",
    "turn",
    "post",
    { op: "blocked_recurrence" },
    { type: "obligation", name: "budget_clamp", metric: "blocked_recurrence", limit: 3 },
    900,
  ),
  seeded(
    "resume-budget",
    "turn",
    "pre",
    { op: "resume" },
    { type: "obligation", name: "budget_clamp", metric: "resume", limit: 10 },
    900,
  ),
]);
