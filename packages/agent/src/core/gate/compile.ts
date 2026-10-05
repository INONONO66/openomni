import { canonicalDigest, type PolicyRow, type PlainValue, type Storage } from "@openomni/protocol";
import { composePointTable, GateComposeError, KERNEL_CAPABILITY_POINTS, type GatePointTable } from "../points";
import { translateLegacyPolicyRow } from "./migrate";
import {
  contentIdentity,
  DEFAULT_COMPILE_KINDS,
  MANDATORY_RULE_NAMES,
  parseRow,
  PolicyCompileError,
  type RuleName,
} from "./legacy-rows";
import { createHandlerTable, wrapTransformer, type HandlerTable } from "./registry";
import { projectGeneration, type ProjectedGeneration } from "./project";
import { evaluateProjected, failedSnapshot, type CompiledPolicySnapshot, type PolicyEvaluationInput } from "./evaluate";

export { createHandlerTable, HandlerTableError, KERNEL_POLICY_REGISTRY, type HandlerTable, type NamedGuard, type NamedTransformer } from "./registry";
export { PolicyCompileError } from "./legacy-rows";
export type { CompiledPolicySnapshot, PolicyEvaluation, PolicyEvaluationInput } from "./evaluate";

/**
 * Policy snapshot compiler (#1251): validates one generation's historical
 * rows (`legacy-rows.ts`), projects them onto the fourteen-point gate
 * (`project.ts`), and exposes the compatibility evaluator (`evaluate.ts`).
 * The compiled gate is the single production evaluator.
 */

export interface CompilePolicySnapshotOptions {
  readonly registry: HandlerTable;
  readonly generation: number;
  readonly rows: readonly PolicyRow.Row[];
  readonly mandatory?: readonly RuleName[];
  readonly kinds?: readonly string[];
  /** The composition's merged point table; defaults to the kernel's built-in capabilities. */
  readonly table?: GatePointTable;
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
  const registry = createHandlerTable(options.registry);
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
  const handlers = new Map([
    ...registry.transformers.map(
      (transformer) => [transformer.name, wrapTransformer(transformer)] as const,
    ),
    // Guards (#1258) are already gate handlers: consulted, verdict-bearing.
    ...(registry.guards ?? []).map((guard) => [guard.name, guard.decide] as const),
  ]);
  const contentHash = canonicalDigest(contentIdentity(options.rows));
  return Object.freeze({
    generation: options.generation,
    contentHash,
    pointTable: table,
    evaluate: (input: PolicyEvaluationInput) =>
      evaluateProjected(projected, handlers, options.generation, contentHash, table, input),
  });
}

type PolicyRowDraft = Omit<PolicyRow.Row, "generation">;

export interface PolicyCompiler {
  pin(generation: number): CompiledPolicySnapshot;
}

export function createPolicyCompiler(options: {
  readonly registry: HandlerTable;
  readonly source: Pick<Storage.PolicyRowSubAdapter, "rows">;
  readonly mandatory?: readonly RuleName[];
  readonly kinds?: readonly string[];
  readonly table?: GatePointTable;
}): PolicyCompiler {
  const registry = createHandlerTable(options.registry);
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
