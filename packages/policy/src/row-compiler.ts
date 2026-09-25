import {
  canonicalDigest,
  Gateway,
  NamedError,
  type PlainValue,
  RowVerdictRead,
  type RowVerdict,
  type PolicyTransform,
  type Policy,
  type PolicyRow,
  type Storage,
} from "@openomni/protocol";
import { z } from "zod";
import { matchesMessage, type MessagePolicyContext } from "./message-match";
import {
  createNamedPolicyRegistry,
  type NamedPolicyRegistry,
  type NamedTransformer,
} from "./named-registry";
import { clonePlain, freezePlain } from "./plain";

const MANDATORY_RULE_NAMES = ["compaction"] as const;
type RuleName = (typeof MANDATORY_RULE_NAMES)[number];

const CORE_ACTION_KINDS = ["prompt", "turn", "llm", "tool", "message"] as const;

const CompileErrorCode = z.enum([
  "generation_mismatch",
  "mandatory_rule_missing",
  "unknown_kind",
  "invalid_match",
  "invalid_verdict",
  "unknown_ref",
  "snapshot_load_failed",
]);
type PolicyCompileErrorCode = z.infer<typeof CompileErrorCode>;

const CompileErrorData = z
  .object({
    code: CompileErrorCode,
    generation: z.number().int().nonnegative(),
    message: z.string(),
    ruleName: z.string().optional(),
    kind: z.string().optional(),
    phase: z.enum(["pre", "post"]).optional(),
    ref: z.string().optional(),
  })
  .strict();

const PolicyCompileErrorBase = NamedError.create("PolicyCompileError", CompileErrorData);

type CompileErrorOptions = Omit<z.input<typeof CompileErrorData>, "message"> & {
  readonly message?: string;
};

export class PolicyCompileError extends PolicyCompileErrorBase {
  static isInstance(input: unknown): input is PolicyCompileError {
    return input instanceof PolicyCompileError && PolicyCompileErrorBase.isInstance(input);
  }

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
    case "unknown_ref":
      return `policy rule ${options.ruleName ?? "<unnamed>"} references unregistered policy ${options.ref ?? "<missing>"}`;
    case "snapshot_load_failed":
      return `policy generation ${options.generation} could not be loaded`;
  }
}

const Match = z
  .object({
    op: z.string().min(1).optional(),
    /** The `operation.op` discriminator inside a multi-operation tool input. */
    operation: z.string().min(1).optional(),
    role: z.enum(["resident", "worker"]).optional(),
    sessionId: z.string().min(1).optional(),
    message: z.union([Gateway.RuleTableA, Gateway.RuleTableB]).optional(),
  })
  .strict();
type Match = z.infer<typeof Match>;

export interface PolicyEvaluationInput {
  readonly kind: string;
  readonly phase: PolicyRow.Phase;
  readonly op?: string;
  readonly role?: "resident" | "worker";
  readonly sessionId?: string;
  readonly message?: MessagePolicyContext;
  readonly value: PlainValue;
}

interface CompiledObligation {
  readonly ref: string;
  readonly metric: Extract<RowVerdict, { type: "obligation" }>["metric"];
  readonly limit: number;
}

type EffectiveRowVerdict = "allow" | "deny" | "require_approval" | "transform" | "obligation";

export interface PolicyEvaluation {
  readonly generation: number;
  readonly snapshotHash: string;
  readonly inputHash: string;
  readonly matchedRuleIds: readonly string[];
  readonly transforms: readonly PolicyTransform[];
  readonly ref?: string;
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

type CompiledVerdict =
  | Exclude<RowVerdict, { type: "transform" }>
  | (Extract<RowVerdict, { type: "transform" }> & { readonly apply: NamedTransformer["apply"] });

interface CompiledRow {
  readonly name: string;
  readonly kind: string;
  readonly phase: PolicyRow.Phase;
  readonly priority: number;
  readonly match: Match;
  readonly verdict: CompiledVerdict;
}

interface BucketSet {
  readonly wildcard: readonly CompiledRow[];
  readonly operations: ReadonlyMap<string, readonly CompiledRow[]>;
}

export interface CompilePolicySnapshotOptions {
  readonly registry: NamedPolicyRegistry;
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

function parseRow(
  row: PolicyRow.Row,
  generation: number,
  kinds: ReadonlySet<string>,
  registry: NamedPolicyRegistry,
): CompiledRow {
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
  const verdict = readVerdict(row);
  if (
    row.kind === "message" &&
    match.data.op !== "assistant" &&
    row.phase === "post" &&
    verdict.type !== "allow" &&
    verdict.type !== "obligation"
  ) {
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
    verdict: resolveVerdict(immutableVerdict(verdict), row, generation, registry),
  });
}

function readVerdict(row: PolicyRow.Row): RowVerdict {
  const verdict = RowVerdictRead.safeParse(row.verdict.value);
  if (!verdict.success) {
    throw new PolicyCompileError({
      code: "invalid_verdict",
      generation: row.generation,
      ruleName: row.name,
      kind: row.kind,
      phase: row.phase,
    });
  }
  return verdict.data;
}

function immutableVerdict(verdict: RowVerdict): RowVerdict {
  const copy = structuredClone(verdict);
  freezePlain(copy);
  return copy;
}

function resolveVerdict(
  verdict: RowVerdict,
  row: PolicyRow.Row,
  generation: number,
  registry: NamedPolicyRegistry,
): CompiledVerdict {
  switch (verdict.type) {
    case "transform": {
      const transformer = registry.transformers.find(({ name }) => name === verdict.ref);
      if (transformer === undefined)
        throw new PolicyCompileError({
          code: "unknown_ref",
          generation,
          ruleName: row.name,
          kind: row.kind,
          phase: row.phase,
          ref: verdict.ref,
        });
      return Object.freeze({ ...verdict, apply: transformer.apply });
    }
    case "obligation":
      if (!registry.obligations.some(({ name }) => name === verdict.ref))
        throw new PolicyCompileError({
          code: "unknown_ref",
          generation,
          ruleName: row.name,
          kind: row.kind,
          phase: row.phase,
          ref: verdict.ref,
        });
      return Object.freeze(verdict);
    case "allow":
    case "deny":
    case "require_approval":
      return Object.freeze(verdict);
  }
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

function innerOperation(value: PlainValue): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const operation = value.operation;
  if (operation === null || typeof operation !== "object" || Array.isArray(operation))
    return undefined;
  return typeof operation.op === "string" ? operation.op : undefined;
}

function matches(row: CompiledRow, input: PolicyEvaluationInput): boolean {
  return (
    (row.match.operation === undefined || row.match.operation === innerOperation(input.value)) &&
    (row.match.role === undefined || row.match.role === input.role) &&
    (row.match.sessionId === undefined || row.match.sessionId === input.sessionId) &&
    (row.match.message === undefined || matchesMessage(row.match.message, input.message))
  );
}

interface CandidateEvaluation {
  readonly matchedRuleIds: string[];
  readonly transforms: PolicyTransform[];
  readonly effects: Policy.PolicyEffect[];
  readonly obligations: CompiledObligation[];
  readonly value: PlainValue;
  readonly verdict: EffectiveRowVerdict;
  readonly reason?: string;
}

interface CandidateState {
  matchedRuleIds: string[];
  transforms: PolicyTransform[];
  effects: Policy.PolicyEffect[];
  obligations: CompiledObligation[];
  value: PlainValue;
  verdict: EffectiveRowVerdict;
  reason?: string | undefined;
}

function applyCandidate(
  candidate: CompiledVerdict,
  ruleId: string,
  state: CandidateState,
): "stop" | "next" {
  if (candidate.type === "deny") {
    state.verdict = "deny";
    state.reason = candidate.reason ?? "denied";
    return "stop";
  }
  if (candidate.type === "require_approval") {
    state.verdict = "require_approval";
    state.reason = candidate.reason;
    return "stop";
  }
  if (candidate.type === "transform") {
    state.verdict = "transform";
    state.value = candidate.apply(freezePlain(state.value), candidate.config ?? null);
    state.transforms.push(Object.freeze({ ruleId, ref: candidate.ref }));
    return "next";
  }
  if (candidate.type === "obligation") {
    if (state.verdict === "allow") state.verdict = "obligation";
    state.obligations.push({
      ref: candidate.ref,
      metric: candidate.metric,
      limit: candidate.limit,
    });
    return "next";
  }
  state.effects.push(...(candidate.effects ?? []));
  state.reason ??= candidate.reason ?? candidate.reasonCodes?.[0];
  return "next";
}

function applyCandidates(
  selected: readonly CompiledRow[],
  input: PolicyEvaluationInput,
  initialValue: PlainValue,
): CandidateEvaluation {
  const missingMessageContext =
    input.kind === "message" && input.op === "send_message" && input.message === undefined;
  const state: CandidateState = {
    matchedRuleIds: [],
    transforms: [],
    effects: [],
    obligations: [],
    value: initialValue,
    verdict: missingMessageContext ? "deny" : "allow",
    reason: missingMessageContext ? "message_context_missing" : undefined,
  };

  for (const compiled of selected) {
    if (missingMessageContext) break;
    if (!matches(compiled, input)) continue;
    state.matchedRuleIds.push(compiled.name);
    if (applyCandidate(compiled.verdict, compiled.name, state) === "stop") break;
  }

  return state;
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
  const evaluation = applyCandidates(selected, input, clonePlain(input.value));

  return Object.freeze({
    generation,
    snapshotHash: contentHash,
    inputHash: canonicalDigest(input),
    matchedRuleIds: Object.freeze(evaluation.matchedRuleIds),
    transforms: Object.freeze(evaluation.transforms),
    ...(evaluation.transforms.length === 1 ? { ref: evaluation.transforms[0]?.ref } : {}),
    verdict: evaluation.verdict,
    ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
    value: evaluation.value,
    effects: Object.freeze(evaluation.effects),
    obligations: Object.freeze(evaluation.obligations),
    bucket: publicBucket(input.kind, input.phase, input.op),
    evaluatedRuleCount: evaluation.matchedRuleIds.length,
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
  const registry = createNamedPolicyRegistry(options.registry);
  const rows = options.rows.map((row) => parseRow(row, options.generation, kinds, registry));
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
        transforms: Object.freeze([]),
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

type PolicyRowDraft = Omit<PolicyRow.Row, "generation">;

export interface PolicyCompiler {
  pin(generation: number): CompiledPolicySnapshot;
}

export function createPolicyCompiler(options: {
  readonly registry: NamedPolicyRegistry;
  readonly source: Pick<Storage.PolicyRowSubAdapter, "rows">;
  readonly mandatory?: readonly RuleName[];
  readonly kinds?: readonly string[];
}): PolicyCompiler {
  const registry = createNamedPolicyRegistry(options.registry);
  const cache = new Map<number, CompiledPolicySnapshot>();
  const mandatory = options.mandatory ?? MANDATORY_RULE_NAMES;

  function pin(generation: number): CompiledPolicySnapshot {
    const found = cache.get(generation);
    if (found !== undefined) return found;
    let compiled: CompiledPolicySnapshot;
    try {
      compiled = compilePolicySnapshot({
        registry,
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

  return { pin };
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
    { type: "obligation", ref: "kernel/budget-clamp", metric: "continuation", limit: 8 },
    900,
  ),
  seeded(
    "fanout-cap",
    "tool",
    "pre",
    { op: "send_message" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "fanout", limit: 8 },
    900,
  ),
  seeded(
    "exact-repeat-cap",
    "turn",
    "post",
    { op: "exact_repeat" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "exact_repeat", limit: 3 },
    900,
  ),
  seeded(
    "toolless-stall-cap",
    "turn",
    "post",
    { op: "toolless_stall" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "toolless_stall", limit: 3 },
    900,
  ),
  seeded(
    "blocked-recurrence-cap",
    "turn",
    "post",
    { op: "blocked_recurrence" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "blocked_recurrence", limit: 3 },
    900,
  ),
  seeded(
    "resume-budget",
    "turn",
    "pre",
    { op: "resume" },
    { type: "obligation", ref: "kernel/budget-clamp", metric: "resume", limit: 10 },
    900,
  ),
]);
