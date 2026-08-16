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
      message: `tool.filter conflicts with tool.require_approval from ${firstFilter.policyId} and ${firstApproval.policyId}`,
    },
  ];
}

export function conflictDiagnostic(conflict: Conflict): Policy.PolicyEffect {
  return {
    type: "audit.annotate",
    annotation: `${FAIL_CLOSED_CONFLICT}: ${conflict.message}`,
    severity: "error",
  };
}
