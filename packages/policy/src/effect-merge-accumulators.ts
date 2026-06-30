import type { Policy } from "@openomni/protocol";
import type {
  ApprovalAccumulator,
  EffectEntry,
  MergedEffect,
  PriorityApprovalAccumulator,
  RetryAccumulator,
} from "./effect-composition-types";

export function selectPriorityEffect(
  current: MergedEffect | undefined,
  entry: EffectEntry,
): MergedEffect {
  const order = Math.min(current?.order ?? entry.order, entry.order);
  if (current && current.priority > entry.priority) return { ...current, order };
  return { effect: entry.effect, order, priority: entry.priority };
}

export function appendReason(
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

export function approvalEffect(
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

export function appendPriorityReason(
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

export function mergeRetry(
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

export function retryEffect(accumulator: RetryAccumulator): Policy.PolicyEffect {
  return accumulator.maxRetries === undefined
    ? { type: "run.retry_after", delayMs: accumulator.delayMs }
    : { type: "run.retry_after", delayMs: accumulator.delayMs, maxRetries: accumulator.maxRetries };
}
