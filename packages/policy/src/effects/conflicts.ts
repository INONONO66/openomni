import type { Policy } from "@openomni/protocol";
import { FAIL_CLOSED_CONFLICT, type Conflict, type EffectEntry, type FieldOwner } from "./types";
import { flattenRecord, pathsOverlap, stableHash } from "./records";

export function collectPreConflicts(entries: EffectEntry[]): Conflict[] {
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
    ...collectSingleValueConflicts(entries, "model.override", "model", "model.override"),
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
    | "writeback.rewrite"
    | "model.override",
  field: "prompt" | "output" | "messages" | "model",
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
    | "writeback.rewrite"
    | "model.override",
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
  // Two same-priority policies routing ONE connection to different models is
  // divergent intent, not composition — the same fail-closed family as
  // prompt.replace (#757 adversarial review F1). Provider+id hash as one value.
  if (effectType === "model.override" && effect.type === "model.override") {
    return { provider: effect.provider, id: effect.id };
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
        message: `writeback.suppress conflicts with writeback.rewrite from ${rewrite.policyId} and ${suppress.policyId}`,
      });
    }
  }

  return conflicts;
}

/**
 * `tool.filter` (hide the tool) and `tool.require_approval` (surface it behind
 * a gate) express irreconcilable intents for the same call. Like every other
 * conflict family, a single policy emitting both is exempt: one author wrote
 * both effects, so there is no divergent intent to arbitrate. Cross-policy
 * pairs stay fail-closed WITHOUT a priority comparison, unlike the rewrite
 * families: those conflict only on divergent *values* where a higher priority
 * can legitimately own the field, whereas filter-vs-approval is a
 * contradiction of enforcement mode itself — letting priority pick one would
 * silently discard the other policy's guard.
 */
function collectFilterApprovalConflicts(entries: EffectEntry[]): Conflict[] {
  const filters = entries.filter((entry) => entry.effect.type === "tool.filter");
  const approvals = entries.filter((entry) => entry.effect.type === "tool.require_approval");

  for (const filter of filters) {
    for (const approval of approvals) {
      if (filter.policyId === approval.policyId) continue;
      return [
        {
          message: `tool.filter conflicts with tool.require_approval from ${filter.policyId} and ${approval.policyId}`,
        },
      ];
    }
  }

  return [];
}

export function conflictDiagnostic(conflict: Conflict): Policy.PolicyEffect {
  return {
    type: "audit.annotate",
    annotation: `${FAIL_CLOSED_CONFLICT}: ${conflict.message}`,
    severity: "error",
  };
}
