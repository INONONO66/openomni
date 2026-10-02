import {
  canonicalDigest,
  Gateway,
  NamedError,
  type GateDecision,
  type GateRow,
  type PlainValue,
  PlainValueSchema,
  type PointId,
  PolicyRef,
  RowVerdictRead,
  type RowVerdict,
  type PolicyTransform,
  type Policy,
  type PolicyRow,
  type Storage,
} from "@openomni/protocol";
import { z } from "zod";
import { clonePlain, freezePlain, matchesMessage, type MessagePolicyContext } from "./match";
import { composePointTable, GateComposeError, KERNEL_CAPABILITY_POINTS, type GatePointTable } from "../points";
import { compileGateRows, type CompiledGate, type GateHandler } from "./compose";
import { legacyPointOf, translateLegacyPolicyRow } from "./migrate";


interface NamedTransformer {
  readonly name: string;
  readonly apply: (args: PlainValue, config: PlainValue) => PlainValue;
}

interface NamedObligation {
  readonly name: string;
}

export interface NamedPolicyRegistry {
  readonly transformers: readonly NamedTransformer[];
  readonly obligations: readonly NamedObligation[];
}

export const NamedPolicyRegistryError = NamedError.create(
  "NamedPolicyRegistryError",
  z
    .object({
      code: z.enum(["invalid_ref", "duplicate_ref"]),
      ref: z.string(),
    })
    .strict(),
);

/** Copies definitions, never freezes caller objects or exposes mutable Maps. */
export function createNamedPolicyRegistry(input: NamedPolicyRegistry): NamedPolicyRegistry {
  const names = new Set<string>();
  for (const entry of [...input.transformers, ...input.obligations]) {
    if (!PolicyRef.safeParse(entry.name).success)
      throw new NamedPolicyRegistryError({ code: "invalid_ref", ref: entry.name });
    if (names.has(entry.name))
      throw new NamedPolicyRegistryError({ code: "duplicate_ref", ref: entry.name });
    names.add(entry.name);
  }
  return Object.freeze({
    transformers: Object.freeze(
      input.transformers.map(({ name, apply }) => Object.freeze({ name, apply })),
    ),
    obligations: Object.freeze(input.obligations.map(({ name }) => Object.freeze({ name }))),
  });
}

const RedactConfig = z
  .object({
    paths: z.array(z.string().min(1)).default([]),
    replacement: PlainValueSchema.optional(),
  })
  .strict();

function redact(args: PlainValue, config: PlainValue): PlainValue {
  const { paths, replacement } = RedactConfig.parse(config ?? {});
  const output = clonePlain(args);
  for (const path of paths) {
    const fields = path.split(".");
    const leaf = fields.pop();
    if (leaf === undefined || leaf.length === 0) continue;
    let parent: PlainValue | undefined = output;
    for (const field of fields) {
      parent =
        parent !== null &&
        typeof parent === "object" &&
        !Array.isArray(parent) &&
        Object.getOwnPropertyDescriptor(parent, field) !== undefined
          ? parent[field]
          : undefined;
    }
    if (
      parent === undefined ||
      parent === null ||
      Array.isArray(parent) ||
      typeof parent !== "object"
    )
      continue;
    if (replacement === undefined) delete parent[leaf];
    else
      Object.defineProperty(parent, leaf, {
        value: clonePlain(replacement),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return output;
}

export const KERNEL_POLICY_REGISTRY: NamedPolicyRegistry = createNamedPolicyRegistry({
  transformers: [{ name: "kernel/redact", apply: redact }],
  obligations: [{ name: "kernel/budget-clamp" }],
});


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
  /** The fourteen-point registry rejected the generation; `composeCode` carries the #1255 code. */
  "compose_rejected",
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
    composeCode: z.string().optional(),
  })
  .strict();

const PolicyCompileErrorBase = NamedError.create("PolicyCompileError", CompileErrorData);

type CompileErrorOptions = Omit<z.input<typeof CompileErrorData>, "message"> & {
  readonly message?: string;
};

export class PolicyCompileError extends PolicyCompileErrorBase {
  static isInstance<Input>(input: Input): input is Input & PolicyCompileError {
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
    case "compose_rejected":
      return `policy generation ${options.generation} was rejected by the point registry (${options.composeCode ?? "unknown"}${options.ref === undefined ? "" : `: ${options.ref}`})`;
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
  /**
   * A previously committed gate decision for this input (#1251 r3): the gate
   * replays it verbatim — recorded responses included — without invoking
   * handlers. Excluded from the evaluation's input identity.
   */
  readonly recorded?: GateDecision;
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
  /** The gate's replayable decision: recorded responses, rewrite output, facts. */
  readonly gate?: GateDecision;
  /** True when `recorded` was replayed verbatim instead of re-evaluated. */
  readonly replayed?: boolean;
  readonly error?: Readonly<z.infer<typeof CompileErrorData>>;
}

export interface CompiledPolicySnapshot {
  readonly generation: number;
  readonly contentHash: string;
  /** The merged point registration table this snapshot compiled against (#1251). */
  readonly pointTable: GatePointTable;
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

export interface CompilePolicySnapshotOptions {
  readonly registry: NamedPolicyRegistry;
  readonly generation: number;
  readonly rows: readonly PolicyRow.Row[];
  readonly mandatory?: readonly RuleName[];
  readonly kinds?: readonly string[];
  /** The composition's merged point table; defaults to the kernel's built-in capabilities. */
  readonly table?: GatePointTable;
}

const DEFAULT_COMPILE_KINDS = [...CORE_ACTION_KINDS, "compaction", "session.configure"] as const;

function rowKey(row: Pick<PolicyRow.Row, "name" | "kind" | "phase">): string {
  return `${row.name}\u0000${row.kind}\u0000${row.phase}`;
}

function publicBucket(kind: string, phase: PolicyRow.Phase, op: string | undefined): string {
  return `${kind}/${phase}/${op ?? "*"}`;
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

function innerOperation(value: PlainValue): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const operation = value.operation;
  if (operation === null || typeof operation !== "object" || Array.isArray(operation))
    return undefined;
  return typeof operation.op === "string" ? operation.op : undefined;
}

// ─── projection: historical rows onto the fourteen-point gate (#1251) ───

/**
 * The compiled gate plus the row identities behind each projected gate row;
 * the gate is the single production evaluator and this metadata only formats
 * its decision back into the legacy `PolicyEvaluation` shape.
 */
interface ProjectedGeneration {
  readonly gate: CompiledGate<MessagePolicyContext>;
  readonly rowById: ReadonlyMap<string, CompiledRow>;
}

/** The legacy row's condition fields, carried verbatim in the gate row's `when`. */
function projectedWhen(match: Match): Record<string, PlainValue> {
  const when: Record<string, PlainValue> = {};
  if (match.op !== undefined) when.op = match.op;
  if (match.operation !== undefined) when.operation = match.operation;
  if (match.role !== undefined) when.role = match.role;
  if (match.sessionId !== undefined) when.sessionId = match.sessionId;
  return when;
}

/** A rewrite row's real fields: the first path segments its transform touches. */
function transformFields(config: PlainValue | undefined): string[] {
  if (config === null || typeof config !== "object" || Array.isArray(config) || config === undefined)
    return [];
  const declared = Array.isArray(config.fields) ? config.fields : undefined;
  const paths = Array.isArray(config.paths) ? config.paths : undefined;
  const segments = (declared ?? paths ?? []).flatMap((entry) =>
    typeof entry === "string" ? [declared === undefined ? (entry.split(".")[0] ?? entry) : entry] : [],
  );
  return [...new Set(segments)];
}

function projectedDoHow(row: CompiledRow): Pick<GateRow, "do" | "how"> {
  switch (row.verdict.type) {
    case "transform":
      return {
        do: "rewrite",
        how: {
          ref: row.verdict.ref,
          fields: transformFields(row.verdict.config),
          ...(row.verdict.config === undefined ? {} : { params: row.verdict.config }),
        },
      };
    case "obligation":
      return {
        do: "gate",
        how: {
          verdict: "allow",
          ref: row.verdict.ref,
          metric: row.verdict.metric,
          limit: row.verdict.limit,
        },
      };
    default:
      return { do: "gate", how: { verdict: row.verdict.type } };
  }
}

/**
 * Every point one historical row governs. The retired v3 point mapping routed
 * compaction operations through `turn/post`, so a wildcard `turn/post` row is
 * projected onto the compaction point too; op-specific compaction rows were
 * already converted onto `compaction/pre` before parsing.
 */
function projectedPoints(row: CompiledRow, table: GatePointTable): PointId[] {
  const point = legacyPointOf(row.kind, row.phase);
  if (point === undefined || !table.has(point))
    throw new GateComposeError({ code: "unknown_point", point: `${row.kind}.${row.phase}` });
  if (point === "turn.post" && row.match.op === undefined && table.has("compaction.pre"))
    return [point, "compaction.pre"];
  return [point];
}

function wrapTransformer(transformer: NamedTransformer): GateHandler {
  return (input) => {
    const output = transformer.apply(freezePlain(input.value), input.params ?? null);
    return {
      value: output,
      payload: { ref: transformer.name, output: canonicalDigest(output) },
    };
  };
}

/**
 * Compiles the generation's rows through the gate-row compiler — the single
 * production evaluator (#1251). Rows are ordered by legacy precedence
 * (priority descending, name ascending); conditions the exact-equality `when`
 * cannot express (message rule tables) compile to per-row matchers.
 */
function projectGeneration(
  parsed: readonly CompiledRow[],
  generation: number,
  table: GatePointTable,
  registry: NamedPolicyRegistry,
): ProjectedGeneration {
  const ordered = [...parsed].sort(
    (left, right) => right.priority - left.priority || left.name.localeCompare(right.name),
  );
  const gateRows: GateRow[] = [];
  const rowById = new Map<string, CompiledRow>();
  const matchers = new Map<string, (context: MessagePolicyContext | undefined) => boolean>();
  ordered.forEach((row, index) => {
    for (const point of projectedPoints(row, table)) {
      const id = `legacy/${point}#${index}`;
      gateRows.push({
        id,
        on: point,
        when: projectedWhen(row.match),
        ...projectedDoHow(row),
        order: index,
        generation,
      });
      rowById.set(id, row);
      const rule = row.match.message;
      if (rule !== undefined) matchers.set(id, (context) => matchesMessage(rule, context));
    }
  });
  const gate = compileGateRows<MessagePolicyContext>({
    table,
    rows: gateRows,
    handlers: [...registry.transformers, ...registry.obligations].map(({ name }) => name),
    generation,
    matchers,
  });
  return { gate, rowById };
}

const VERDICT_PRECEDENCE: Record<"deny" | "require_approval" | "allow", readonly RowVerdict["type"][]> = {
  deny: ["deny"],
  require_approval: ["require_approval"],
  allow: ["allow"],
};

function evaluateProjected(
  projected: ProjectedGeneration,
  handlers: ReadonlyMap<string, GateHandler>,
  generation: number,
  contentHash: string,
  table: GatePointTable,
  input: PolicyEvaluationInput,
): PolicyEvaluation {
  // The recorded decision is replay input, never part of the input identity.
  const { recorded, ...identity } = input;
  const inputHash = canonicalDigest(identity);
  const refused = (reason: string): PolicyEvaluation =>
    Object.freeze({
      generation,
      snapshotHash: contentHash,
      inputHash,
      matchedRuleIds: Object.freeze([]),
      transforms: Object.freeze([]),
      verdict: "deny" as const,
      reason,
      value: clonePlain(input.value),
      effects: Object.freeze([]),
      obligations: Object.freeze([]),
      bucket: publicBucket(input.kind, input.phase, input.op),
      evaluatedRuleCount: 0,
    });
  const point = legacyPointOf(input.kind, input.phase);
  if (point === undefined || !table.has(point)) return refused("unknown_point");
  if (input.kind === "message" && input.op === "send_message" && input.message === undefined)
    return refused("message_context_missing");

  const when: Record<string, PlainValue> = {};
  if (input.op !== undefined) when.op = input.op;
  const operation = innerOperation(input.value);
  if (operation !== undefined) when.operation = operation;
  if (input.role !== undefined) when.role = input.role;
  if (input.sessionId !== undefined) when.sessionId = input.sessionId;

  const outcome = projected.gate.decide(
    point,
    { when, value: clonePlain(input.value), context: input.message },
    { handlers: (ref) => handlers.get(ref), ...(recorded === undefined ? {} : { recorded }) },
  );
  const matched = outcome.decision.rowIds.flatMap((id) => {
    const row = projected.rowById.get(id);
    return row === undefined ? [] : [row];
  });
  const transforms = matched.flatMap((row) =>
    row.verdict.type === "transform" ? [Object.freeze({ ruleId: row.name, ref: row.verdict.ref })] : [],
  );
  const obligations = matched.flatMap((row) =>
    row.verdict.type === "obligation"
      ? [{ ref: row.verdict.ref, metric: row.verdict.metric, limit: row.verdict.limit }]
      : [],
  );
  const effects = matched.flatMap((row) =>
    row.verdict.type === "allow" ? (row.verdict.effects ?? []) : [],
  );
  const verdict: EffectiveRowVerdict =
    outcome.decision.verdict !== "allow"
      ? outcome.decision.verdict
      : transforms.length > 0
        ? "transform"
        : obligations.length > 0
          ? "obligation"
          : "allow";
  const reason = projectedReason(outcome.decision.verdict, matched);

  return Object.freeze({
    generation,
    snapshotHash: contentHash,
    inputHash,
    matchedRuleIds: Object.freeze(matched.map((row) => row.name)),
    transforms: Object.freeze(transforms),
    ...(transforms.length === 1 ? { ref: transforms[0]?.ref } : {}),
    verdict,
    ...(reason === undefined ? {} : { reason }),
    value: outcome.value,
    effects: Object.freeze(effects),
    obligations: Object.freeze(obligations),
    bucket: publicBucket(input.kind, input.phase, input.op),
    evaluatedRuleCount: matched.length,
    gate: outcome.decision,
    replayed: outcome.replayed,
  });
}

/** The highest-precedence matched row's reason: deny defaults to `denied`. */
function projectedReason(
  verdict: "deny" | "require_approval" | "allow",
  matched: readonly CompiledRow[],
): string | undefined {
  const types = VERDICT_PRECEDENCE[verdict];
  for (const row of matched) {
    if (!types.includes(row.verdict.type)) continue;
    if (row.verdict.type === "deny") return row.verdict.reason ?? "denied";
    if (row.verdict.type === "require_approval") return row.verdict.reason;
    if (row.verdict.type === "allow") {
      const reason = row.verdict.reason ?? row.verdict.reasonCodes?.[0];
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
}

/** The kernel's default composition: core plus every built-in capability. */
function kernelPointTable(): GatePointTable {
  return composePointTable({ capabilities: KERNEL_CAPABILITY_POINTS });
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
  const table = options.table ?? kernelPointTable();
  // Historical compaction rows convert onto the compaction point before
  // evaluation, so a base-era `turn/post {op: compaction}` deny keeps
  // refusing summarization (#1251).
  const translated = options.rows.map(translateLegacyPolicyRow);
  const rows = translated.map((row) => parseRow(row, options.generation, kinds, registry));
  let projected: ProjectedGeneration;
  try {
    projected = projectGeneration(rows, options.generation, table, registry);
  } catch (cause) {
    if (!GateComposeError.isInstance(cause)) throw cause;
    throw new PolicyCompileError({
      code: "compose_rejected",
      generation: options.generation,
      composeCode: cause.data.code,
      ...(cause.data.point === undefined ? {} : { kind: cause.data.point }),
      ...(cause.data.ref === undefined ? {} : { ref: cause.data.ref }),
    });
  }
  const handlers = new Map(
    registry.transformers.map((transformer) => [transformer.name, wrapTransformer(transformer)]),
  );
  const contentHash = canonicalDigest(contentIdentity(options.rows));
  return Object.freeze({
    generation: options.generation,
    contentHash,
    pointTable: table,
    evaluate: (input: PolicyEvaluationInput) =>
      evaluateProjected(projected, handlers, options.generation, contentHash, table, input),
  });
}

function failedSnapshot(error: PolicyCompileError, table: GatePointTable): CompiledPolicySnapshot {
  const contentHash = canonicalDigest({ generation: error.generation, error: error.data });
  return Object.freeze({
    generation: error.generation,
    contentHash,
    pointTable: table,
    evaluate(input: PolicyEvaluationInput) {
      const { recorded: _recorded, ...identity } = input;
      return Object.freeze({
        generation: error.generation,
        snapshotHash: contentHash,
        inputHash: canonicalDigest(identity),
        matchedRuleIds: Object.freeze([]),
        transforms: Object.freeze([]),
        verdict: "deny",
        reason: error.data.composeCode ?? error.code,
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
  readonly table?: GatePointTable;
}): PolicyCompiler {
  const registry = createNamedPolicyRegistry(options.registry);
  const cache = new Map<number, CompiledPolicySnapshot>();
  const mandatory = options.mandatory ?? MANDATORY_RULE_NAMES;
  const table = options.table ?? kernelPointTable();

  function pin(generation: number): CompiledPolicySnapshot {
    const found = cache.get(generation);
    if (found !== undefined) return found;
    const compiled = loadSnapshot(generation);
    cache.set(generation, compiled);
    return compiled;
  }

  function loadSnapshot(generation: number): CompiledPolicySnapshot {
    let rows: readonly PolicyRow.Row[];
    try {
      rows = options.source.rows(generation);
    } catch {
      return failedSnapshot(
        new PolicyCompileError({
          code: "snapshot_load_failed",
          generation,
          message: "policy snapshot load failed",
        }),
        table,
      );
    }
    try {
      return compilePolicySnapshot({
        registry,
        generation,
        rows,
        mandatory,
        table,
        ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
      });
    } catch (error) {
      if (PolicyCompileError.isInstance(error)) return failedSnapshot(error, table);
      throw error;
    }
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
  seeded("compaction", "compaction", "pre", {}, { type: "allow" }, 1_000),
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
