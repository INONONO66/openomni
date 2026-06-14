import type { Policy } from "@openomni/protocol";

type Boundary = "pre" | "post";

export interface OrderedDecision {
  readonly decision: Policy.PolicyDecision;
  readonly priority: number;
  readonly index: number;
}

export interface EffectEntry {
  readonly effect: Policy.PolicyEffect;
  readonly policyId: string;
  readonly priority: number;
  readonly decisionIndex: number;
  readonly effectIndex: number;
  readonly order: number;
}

export interface Conflict {
  readonly boundary: Boundary;
  readonly message: string;
}

export interface FieldOwner {
  readonly path: string;
  readonly policyId: string;
  readonly valueHash: string;
  readonly priority: number;
}

export interface MergedEffect {
  readonly effect: Policy.PolicyEffect;
  readonly order: number;
  readonly priority: number;
}

export interface ApprovalAccumulator {
  readonly order: number;
  readonly reasons: string[];
}

export interface PriorityApprovalAccumulator extends ApprovalAccumulator {
  readonly priority: number;
}

export interface RetryAccumulator {
  readonly order: number;
  readonly delayMs: number;
  readonly maxRetries?: number;
}

export interface MergeResult {
  readonly effects: Policy.PolicyEffect[];
  readonly postConflicts: Conflict[];
}

export const FAIL_CLOSED_CONFLICT = "policy.effect_conflict.fail_closed";
export const POST_BOUNDARY_CONFLICT = "policy.effect_conflict.post_boundary";
