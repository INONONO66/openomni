import type {
  ApprovalAccumulator,
  MergedEffect,
  PriorityApprovalAccumulator,
  RetryAccumulator,
} from "../types";
import { approvalEffect, retryEffect } from "./accumulators";

export interface EffectAccumulatorSet {
  readonly promptReplace?: MergedEffect;
  /** Single-winner model.override (#753) — the priority-selected reroute for the gated connection. */
  readonly modelOverride?: MergedEffect;
  readonly toolFilters: ReadonlyMap<string, number>;
  readonly toolRewrite?: { readonly input: Record<string, unknown>; readonly order: number };
  readonly toolOutputRewrite?: MergedEffect;
  readonly toolSkip?: MergedEffect;
  readonly toolApproval?: ApprovalAccumulator;
  readonly runAbort?: MergedEffect;
  readonly continueWithPrompt?: MergedEffect;
  readonly retryAfter?: RetryAccumulator;
  readonly runReplaceMessages?: MergedEffect;
  readonly delegationConstraints?: {
    readonly constraints: Record<string, unknown>;
    readonly order: number;
  };
  readonly delegationApproval?: ApprovalAccumulator;
  readonly writebackRewrite?: MergedEffect;
  readonly writebackSuppress?: PriorityApprovalAccumulator;
  readonly workspaceLock?: { readonly required: boolean; readonly order: number };
}

export function appendMergedEffects(
  merged: MergedEffect[],
  accumulators: EffectAccumulatorSet,
): void {
  if (accumulators.promptReplace) merged.push(accumulators.promptReplace);
  if (accumulators.modelOverride) merged.push(accumulators.modelOverride);
  for (const [toolPattern, order] of accumulators.toolFilters) {
    merged.push({ effect: { type: "tool.filter", toolPattern }, order, priority: 0 });
  }
  if (accumulators.toolRewrite) {
    merged.push({
      effect: { type: "tool.rewrite_input", input: accumulators.toolRewrite.input },
      order: accumulators.toolRewrite.order,
      priority: 0,
    });
  }
  if (accumulators.toolOutputRewrite) merged.push(accumulators.toolOutputRewrite);
  if (accumulators.toolSkip) merged.push(accumulators.toolSkip);
  if (accumulators.toolApproval) {
    merged.push({
      effect: approvalEffect("tool.require_approval", accumulators.toolApproval),
      order: accumulators.toolApproval.order,
      priority: 0,
    });
  }
  appendRunEffects(merged, accumulators);
  appendDelegationEffects(merged, accumulators);
  appendWritebackEffects(merged, accumulators);
  appendRuntimeEffects(merged, accumulators);
}

function appendRunEffects(merged: MergedEffect[], accumulators: EffectAccumulatorSet): void {
  if (accumulators.runAbort) merged.push(accumulators.runAbort);
  if (accumulators.continueWithPrompt) merged.push(accumulators.continueWithPrompt);
  if (accumulators.retryAfter) {
    merged.push({
      effect: retryEffect(accumulators.retryAfter),
      order: accumulators.retryAfter.order,
      priority: 0,
    });
  }
  if (accumulators.runReplaceMessages) merged.push(accumulators.runReplaceMessages);
}

function appendDelegationEffects(merged: MergedEffect[], accumulators: EffectAccumulatorSet): void {
  if (accumulators.delegationConstraints) {
    merged.push({
      effect: {
        type: "delegation.set_constraints",
        constraints: accumulators.delegationConstraints.constraints,
      },
      order: accumulators.delegationConstraints.order,
      priority: 0,
    });
  }
  if (accumulators.delegationApproval) {
    merged.push({
      effect: approvalEffect("delegation.require_approval", accumulators.delegationApproval),
      order: accumulators.delegationApproval.order,
      priority: 0,
    });
  }
}

function appendWritebackEffects(merged: MergedEffect[], accumulators: EffectAccumulatorSet): void {
  if (
    accumulators.writebackSuppress &&
    (!accumulators.writebackRewrite ||
      accumulators.writebackSuppress.priority >= accumulators.writebackRewrite.priority)
  ) {
    merged.push({
      effect: approvalEffect("writeback.suppress", accumulators.writebackSuppress),
      order: accumulators.writebackSuppress.order,
      priority: accumulators.writebackSuppress.priority,
    });
  } else if (accumulators.writebackRewrite) {
    merged.push(accumulators.writebackRewrite);
  }
}

function appendRuntimeEffects(merged: MergedEffect[], accumulators: EffectAccumulatorSet): void {
  if (accumulators.workspaceLock) {
    merged.push({
      effect: { type: "runtime.workspace_lock", required: accumulators.workspaceLock.required },
      order: accumulators.workspaceLock.order,
      priority: 0,
    });
  }
}
