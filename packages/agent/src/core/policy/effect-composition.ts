import type { Policy } from "@openomni/protocol";

type Boundary = "pre" | "post";

interface OrderedDecision {
  readonly decision: Policy.PolicyDecision;
  readonly priority: number;
  readonly index: number;
}

interface EffectEntry {
  readonly effect: Policy.PolicyEffect;
  readonly policyId: string;
  readonly priority: number;
  readonly decisionIndex: number;
  readonly effectIndex: number;
  readonly order: number;
}

interface Conflict {
  readonly boundary: Boundary;
  readonly message: string;
}

interface FieldOwner {
  readonly path: string;
  readonly policyId: string;
  readonly valueHash: string;
  readonly priority: number;
}

interface MergedEffect {
  readonly effect: Policy.PolicyEffect;
  readonly order: number;
  readonly priority: number;
}

interface ApprovalAccumulator {
  readonly order: number;
  readonly reasons: string[];
}

interface PriorityApprovalAccumulator extends ApprovalAccumulator {
  readonly priority: number;
}

interface RetryAccumulator {
  readonly order: number;
  readonly delayMs: number;
  readonly maxRetries?: number;
}

interface MergeResult {
  readonly effects: Policy.PolicyEffect[];
  readonly postConflicts: Conflict[];
}

const FAIL_CLOSED_CONFLICT = "policy.effect_conflict.fail_closed";
const POST_BOUNDARY_CONFLICT = "policy.effect_conflict.post_boundary";

export function composeEffects(decisions: Policy.PolicyDecision[]): Policy.EffectiveDecision {
  const orderedDecisions = orderDecisions(decisions);
  const contributingPolicies = uniquePolicyIds(
    orderedDecisions.map(({ decision }) => decision.policyId),
  );

  if (orderedDecisions.some(({ decision }) => decision.verdict === "deny")) {
    return {
      verdict: "deny",
      mergedEffects: collectSafeDenyEffects(orderedDecisions),
      obligations: [],
      contributingPolicies,
    };
  }

  const entries = collectEffectEntries(orderedDecisions);
  const preConflicts = collectPreConflicts(entries);
  if (preConflicts.length > 0) {
    return {
      verdict: "deny",
      mergedEffects: preConflicts.map(conflictDiagnostic),
      obligations: [],
      contributingPolicies,
    };
  }

  const merged = mergeEntries(entries);
  const verdict = orderedDecisions.some(({ decision }) => decision.verdict === "pending")
    ? "pending"
    : "allow";

  return {
    verdict,
    mergedEffects: [...merged.effects, ...merged.postConflicts.map(conflictDiagnostic)],
    obligations: verdict === "pending" ? collectObligations(orderedDecisions) : [],
    contributingPolicies,
  };
}

function orderDecisions(decisions: Policy.PolicyDecision[]): OrderedDecision[] {
  return decisions
    .map((decision, index) => ({ decision, priority: decisionPriority(decision), index }))
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      const policyOrder = left.decision.policyId.localeCompare(right.decision.policyId);
      return policyOrder === 0 ? left.index - right.index : policyOrder;
    });
}

function decisionPriority(decision: Policy.PolicyDecision): number {
  if ("priority" in decision && typeof decision.priority === "number") return decision.priority;
  return 0;
}

function uniquePolicyIds(policyIds: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const policyId of policyIds) {
    if (seen.has(policyId)) continue;
    seen.add(policyId);
    result.push(policyId);
  }

  return result;
}

function collectEffectEntries(orderedDecisions: OrderedDecision[]): EffectEntry[] {
  const seenEffects = new Set<string>();
  const entries: EffectEntry[] = [];

  for (const ordered of orderedDecisions) {
    ordered.decision.effects.forEach((effect, effectIndex) => {
      const effectHash = stableHash(effect);
      if (seenEffects.has(effectHash)) return;

      seenEffects.add(effectHash);
      entries.push({
        effect,
        policyId: ordered.decision.policyId,
        priority: ordered.priority,
        decisionIndex: ordered.index,
        effectIndex,
        order: ordered.index * 10_000 + effectIndex,
      });
    });
  }

  return entries
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      const policyOrder = left.policyId.localeCompare(right.policyId);
      if (policyOrder !== 0) return policyOrder;
      if (left.decisionIndex !== right.decisionIndex)
        return left.decisionIndex - right.decisionIndex;
      return left.effectIndex - right.effectIndex;
    })
    .map((entry, order) => ({ ...entry, order }));
}

function collectSafeDenyEffects(orderedDecisions: OrderedDecision[]): Policy.PolicyEffect[] {
  return collectEffectEntries(orderedDecisions)
    .filter((entry) => entry.effect.type === "audit.annotate" || entry.effect.type === "run.abort")
    .map((entry) => entry.effect);
}

function collectObligations(orderedDecisions: OrderedDecision[]): Policy.PolicyObligation[] {
  return orderedDecisions.flatMap(({ decision }) => decision.obligations ?? []);
}

function collectPreConflicts(entries: EffectEntry[]): Conflict[] {
  return [
    ...collectRecordRewriteConflicts(entries, "tool.rewrite_input"),
    ...collectRecordRewriteConflicts(entries, "delegation.set_constraints"),
    ...collectSingleValueConflicts(entries, "prompt.replace", "prompt", "prompt.replace"),
    ...collectSingleValueConflicts(entries, "tool.rewrite_output", "output", "tool.rewrite_output"),
    ...collectSingleValueConflicts(
      entries,
      "run.continue_with_prompt",
      "prompt",
      "run.continue_with_prompt",
    ),
    ...collectSingleValueConflicts(
      entries,
      "run.replace_messages",
      "messages",
      "run.replace_messages",
    ),
    ...collectSingleValueConflicts(entries, "writeback.rewrite", "output", "writeback.rewrite"),
    ...collectWritebackSuppressConflicts(entries),
    ...collectFilterApprovalConflicts(entries),
  ];
}

function collectRecordRewriteConflicts(
  entries: EffectEntry[],
  effectType: "tool.rewrite_input" | "delegation.set_constraints",
): Conflict[] {
  const owners: FieldOwner[] = [];
  const conflicts: Conflict[] = [];

  for (const entry of entries) {
    const record = recordForEffect(entry.effect, effectType);
    if (!record) continue;

    for (const [path, value] of flattenRecord(record)) {
      const valueHash = stableHash(value);
      const owner = highestPriorityOwner(owners, path, entry.policyId);

      if (owner && owner.valueHash !== valueHash) {
        if (owner.priority === entry.priority) {
          conflicts.push({
            boundary: "pre",
            message: `${effectType}.${path} rewritten by ${owner.policyId} and ${entry.policyId}`,
          });
        }
        if (owner.priority > entry.priority) continue;
      }

      if (!owner || entry.priority >= owner.priority) {
        owners.push({ path, policyId: entry.policyId, valueHash, priority: entry.priority });
      }
    }
  }

  return conflicts;
}

function highestPriorityOwner(
  owners: readonly FieldOwner[],
  path: string,
  policyId: string,
): FieldOwner | undefined {
  return owners
    .filter((candidate) => pathsOverlap(candidate.path, path) && candidate.policyId !== policyId)
    .sort((left, right) => right.priority - left.priority)[0];
}

function recordForEffect(
  effect: Policy.PolicyEffect,
  effectType: "tool.rewrite_input" | "delegation.set_constraints",
): Record<string, unknown> | undefined {
  if (effectType === "tool.rewrite_input" && effect.type === "tool.rewrite_input") {
    return effect.input;
  }
  if (effectType === "delegation.set_constraints" && effect.type === "delegation.set_constraints") {
    return effect.constraints;
  }
  return undefined;
}

function collectSingleValueConflicts(
  entries: EffectEntry[],
  effectType:
    | "prompt.replace"
    | "tool.rewrite_output"
    | "run.continue_with_prompt"
    | "run.replace_messages"
    | "writeback.rewrite",
  field: "prompt" | "output" | "messages",
  label: string,
): Conflict[] {
  const conflicts: Conflict[] = [];
  let owner: FieldOwner | undefined;

  for (const entry of entries) {
    const value = singleValueForEffect(entry.effect, effectType);
    if (value === undefined) continue;

    const valueHash = stableHash(value);
    if (owner && owner.policyId !== entry.policyId && owner.valueHash !== valueHash) {
      if (owner.priority === entry.priority) {
        conflicts.push({
          boundary: "pre",
          message: `${label}.${field} rewritten by ${owner.policyId} and ${entry.policyId}`,
        });
      }
      if (owner.priority > entry.priority) continue;
    }

    if (!owner || entry.priority >= owner.priority) {
      owner = { path: field, policyId: entry.policyId, valueHash, priority: entry.priority };
    }
  }

  return conflicts;
}

function singleValueForEffect(
  effect: Policy.PolicyEffect,
  effectType:
    | "prompt.replace"
    | "tool.rewrite_output"
    | "run.continue_with_prompt"
    | "run.replace_messages"
    | "writeback.rewrite",
): unknown {
  if (effectType === "prompt.replace" && effect.type === "prompt.replace") return effect.prompt;
  if (effectType === "tool.rewrite_output" && effect.type === "tool.rewrite_output") {
    return effect.output;
  }
  if (effectType === "run.continue_with_prompt" && effect.type === "run.continue_with_prompt") {
    return effect.prompt;
  }
  if (effectType === "run.replace_messages" && effect.type === "run.replace_messages") {
    return effect.messages;
  }
  if (effectType === "writeback.rewrite" && effect.type === "writeback.rewrite") {
    return effect.output;
  }
  return undefined;
}

function collectWritebackSuppressConflicts(entries: EffectEntry[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const rewrites = entries.filter((entry) => entry.effect.type === "writeback.rewrite");
  const suppressions = entries.filter((entry) => entry.effect.type === "writeback.suppress");

  for (const rewrite of rewrites) {
    for (const suppress of suppressions) {
      if (rewrite.policyId === suppress.policyId || rewrite.priority !== suppress.priority) {
        continue;
      }
      conflicts.push({
        boundary: "pre",
        message: `writeback.suppress conflicts with writeback.rewrite from ${rewrite.policyId} and ${suppress.policyId}`,
      });
    }
  }

  return conflicts;
}

function collectFilterApprovalConflicts(entries: EffectEntry[]): Conflict[] {
  const firstFilter = entries.find((entry) => entry.effect.type === "tool.filter");
  const firstApproval = entries.find((entry) => entry.effect.type === "tool.require_approval");

  if (!firstFilter || !firstApproval) return [];

  return [
    {
      boundary: "pre",
      message: `tool.filter conflicts with tool.require_approval from ${firstFilter.policyId} and ${firstApproval.policyId}`,
    },
  ];
}

function mergeEntries(entries: EffectEntry[]): MergeResult {
  const merged: MergedEffect[] = [];
  const postConflicts = collectPostConflicts(entries);
  const toolFilters = new Map<string, number>();
  let toolRewrite: { input: Record<string, unknown>; order: number } | undefined;
  let toolOutputRewrite: MergedEffect | undefined;
  let toolSkip: MergedEffect | undefined;
  let toolApproval: ApprovalAccumulator | undefined;
  let runAbort: MergedEffect | undefined;
  let continueWithPrompt: MergedEffect | undefined;
  let retryAfter: RetryAccumulator | undefined;
  let runReplaceMessages: MergedEffect | undefined;
  let delegationConstraints: { constraints: Record<string, unknown>; order: number } | undefined;
  let delegationApproval: ApprovalAccumulator | undefined;
  let promptReplace: MergedEffect | undefined;
  let writebackRewrite: MergedEffect | undefined;
  let writebackSuppress: PriorityApprovalAccumulator | undefined;
  let timeout: { timeoutMs: number; order: number } | undefined;
  let workspaceLock: { required: boolean; order: number } | undefined;

  for (const entry of entries) {
    const { effect } = entry;

    switch (effect.type) {
      case "prompt.append_context":
      case "prompt.inject_message":
      case "audit.annotate":
        merged.push({ effect, order: entry.order, priority: entry.priority });
        break;
      case "prompt.replace":
        promptReplace = selectPriorityEffect(promptReplace, entry);
        break;
      case "tool.filter":
        if (!toolFilters.has(effect.toolPattern)) toolFilters.set(effect.toolPattern, entry.order);
        break;
      case "tool.rewrite_input":
        toolRewrite = {
          input: deepMergeRecords(toolRewrite?.input ?? {}, effect.input),
          order: Math.min(toolRewrite?.order ?? entry.order, entry.order),
        };
        break;
      case "tool.rewrite_output":
        toolOutputRewrite = selectPriorityEffect(toolOutputRewrite, entry);
        break;
      case "tool.skip_invocation":
        toolSkip ??= { effect, order: entry.order, priority: entry.priority };
        break;
      case "tool.require_approval":
        toolApproval = appendReason(toolApproval, effect.reason, entry.order);
        break;
      case "run.abort":
        runAbort ??= { effect, order: entry.order, priority: entry.priority };
        break;
      case "run.continue_with_prompt":
        continueWithPrompt = selectPriorityEffect(continueWithPrompt, entry);
        break;
      case "run.retry_after":
        retryAfter = mergeRetry(retryAfter, effect, entry.order);
        break;
      case "run.replace_messages":
        runReplaceMessages = selectPriorityEffect(runReplaceMessages, entry);
        break;
      case "delegation.set_constraints":
        delegationConstraints = {
          constraints: deepMergeRecords(
            delegationConstraints?.constraints ?? {},
            effect.constraints,
          ),
          order: Math.min(delegationConstraints?.order ?? entry.order, entry.order),
        };
        break;
      case "delegation.require_approval":
        delegationApproval = appendReason(delegationApproval, effect.reason, entry.order);
        break;
      case "writeback.rewrite":
        writebackRewrite = selectPriorityEffect(writebackRewrite, entry);
        break;
      case "writeback.suppress":
        writebackSuppress = appendPriorityReason(
          writebackSuppress,
          effect.reason,
          entry.order,
          entry.priority,
        );
        break;
      case "runtime.set_timeout":
        timeout = {
          timeoutMs: Math.min(timeout?.timeoutMs ?? effect.timeoutMs, effect.timeoutMs),
          order: Math.min(timeout?.order ?? entry.order, entry.order),
        };
        break;
      case "runtime.workspace_lock":
        workspaceLock = {
          required: (workspaceLock?.required ?? false) || effect.required,
          order: Math.min(workspaceLock?.order ?? entry.order, entry.order),
        };
        break;
      default:
        assertNever(effect);
    }
  }

  if (promptReplace) merged.push(promptReplace);
  for (const [toolPattern, order] of toolFilters) {
    merged.push({ effect: { type: "tool.filter", toolPattern }, order, priority: 0 });
  }
  if (toolRewrite)
    merged.push({
      effect: { type: "tool.rewrite_input", input: toolRewrite.input },
      order: toolRewrite.order,
      priority: 0,
    });
  if (toolOutputRewrite) merged.push(toolOutputRewrite);
  if (toolSkip) merged.push(toolSkip);
  if (toolApproval)
    merged.push({
      effect: approvalEffect("tool.require_approval", toolApproval),
      order: toolApproval.order,
      priority: 0,
    });
  if (runAbort) merged.push(runAbort);
  if (continueWithPrompt) merged.push(continueWithPrompt);
  if (retryAfter)
    merged.push({ effect: retryEffect(retryAfter), order: retryAfter.order, priority: 0 });
  if (runReplaceMessages) merged.push(runReplaceMessages);
  if (delegationConstraints) {
    merged.push({
      effect: {
        type: "delegation.set_constraints",
        constraints: delegationConstraints.constraints,
      },
      order: delegationConstraints.order,
      priority: 0,
    });
  }
  if (delegationApproval) {
    merged.push({
      effect: approvalEffect("delegation.require_approval", delegationApproval),
      order: delegationApproval.order,
      priority: 0,
    });
  }
  if (
    writebackSuppress &&
    (!writebackRewrite || writebackSuppress.priority >= writebackRewrite.priority)
  ) {
    merged.push({
      effect: approvalEffect("writeback.suppress", writebackSuppress),
      order: writebackSuppress.order,
      priority: writebackSuppress.priority,
    });
  } else if (writebackRewrite) {
    merged.push(writebackRewrite);
  }
  if (timeout)
    merged.push({
      effect: { type: "runtime.set_timeout", timeoutMs: timeout.timeoutMs },
      order: timeout.order,
      priority: 0,
    });
  if (workspaceLock) {
    merged.push({
      effect: { type: "runtime.workspace_lock", required: workspaceLock.required },
      order: workspaceLock.order,
      priority: 0,
    });
  }

  return {
    effects: merged.sort((left, right) => left.order - right.order).map(({ effect }) => effect),
    postConflicts,
  };
}

function collectPostConflicts(_entries: EffectEntry[]): Conflict[] {
  return [];
}

function selectPriorityEffect(current: MergedEffect | undefined, entry: EffectEntry): MergedEffect {
  const order = Math.min(current?.order ?? entry.order, entry.order);
  if (current && current.priority > entry.priority) return { ...current, order };
  return { effect: entry.effect, order, priority: entry.priority };
}

function appendReason(
  accumulator: ApprovalAccumulator | undefined,
  reason: string | undefined,
  order: number,
): ApprovalAccumulator {
  return {
    order: Math.min(accumulator?.order ?? order, order),
    reasons:
      reason === undefined
        ? (accumulator?.reasons ?? [])
        : [...(accumulator?.reasons ?? []), reason],
  };
}

function approvalEffect(
  type: "tool.require_approval" | "delegation.require_approval" | "writeback.suppress",
  accumulator: ApprovalAccumulator,
): Policy.PolicyEffect {
  const reason = accumulator.reasons.length > 0 ? accumulator.reasons.join("; ") : undefined;

  if (type === "tool.require_approval") {
    return reason === undefined ? { type } : { type, reason };
  }
  if (type === "delegation.require_approval") {
    return reason === undefined ? { type } : { type, reason };
  }
  return reason === undefined ? { type } : { type, reason };
}

function appendPriorityReason(
  accumulator: PriorityApprovalAccumulator | undefined,
  reason: string | undefined,
  order: number,
  priority: number,
): PriorityApprovalAccumulator {
  if (accumulator && accumulator.priority > priority) {
    return { ...accumulator, order: Math.min(accumulator.order, order) };
  }

  if (accumulator && accumulator.priority === priority) {
    return {
      order: Math.min(accumulator.order, order),
      priority,
      reasons: reason === undefined ? accumulator.reasons : [...accumulator.reasons, reason],
    };
  }

  return {
    order: Math.min(accumulator?.order ?? order, order),
    priority,
    reasons: reason === undefined ? [] : [reason],
  };
}

function mergeRetry(
  accumulator: RetryAccumulator | undefined,
  effect: Extract<Policy.PolicyEffect, { type: "run.retry_after" }>,
  order: number,
): RetryAccumulator {
  const currentMaxRetries = accumulator?.maxRetries;
  const nextMaxRetries = effect.maxRetries;
  const maxRetries =
    currentMaxRetries === undefined
      ? nextMaxRetries
      : nextMaxRetries === undefined
        ? currentMaxRetries
        : Math.min(currentMaxRetries, nextMaxRetries);

  return {
    order: Math.min(accumulator?.order ?? order, order),
    delayMs: Math.max(accumulator?.delayMs ?? effect.delayMs, effect.delayMs),
    ...(maxRetries !== undefined && { maxRetries }),
  };
}

function retryEffect(accumulator: RetryAccumulator): Policy.PolicyEffect {
  return accumulator.maxRetries === undefined
    ? { type: "run.retry_after", delayMs: accumulator.delayMs }
    : { type: "run.retry_after", delayMs: accumulator.delayMs, maxRetries: accumulator.maxRetries };
}

function conflictDiagnostic(conflict: Conflict): Policy.PolicyEffect {
  const prefix = conflict.boundary === "pre" ? FAIL_CLOSED_CONFLICT : POST_BOUNDARY_CONFLICT;
  const severity = conflict.boundary === "pre" ? "error" : "warning";

  return {
    type: "audit.annotate",
    annotation: `${prefix}: ${conflict.message}`,
    severity,
  };
}

function flattenRecord(record: Record<string, unknown>, prefix = ""): [string, unknown][] {
  const fields: [string, unknown][] = [];

  for (const key of Object.keys(record).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = record[key];

    if (isRecord(value) && Object.keys(value).length > 0) {
      fields.push(...flattenRecord(value, path));
      continue;
    }

    fields.push([path, value]);
  }

  return fields;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function deepMergeRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...left };

  for (const [key, value] of Object.entries(right)) {
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? deepMergeRecords(current, value) : value;
  }

  return result;
}

function stableHash(value: unknown): string {
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return `${typeof value}:${JSON.stringify(value)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled policy effect: ${stableStringify(value)}`);
}
