import type { WorkItem } from "@openomni/protocol";

const DEFAULT_MAX_ATTEMPTS_BY_EXECUTOR: Readonly<Partial<Record<WorkItem.ExecutorKind, number>>> = {
  internal_chat_agent: 3,
};

export function defaultMaxAttempts(
  executorKind: WorkItem.ExecutorKind | undefined,
): number | undefined {
  return executorKind ? DEFAULT_MAX_ATTEMPTS_BY_EXECUTOR[executorKind] : undefined;
}

export function isRetryExhausted(item: WorkItem.Info): boolean {
  return item.maxAttempts !== undefined && item.attempt >= item.maxAttempts;
}

export function retryExhaustionDescription(item: WorkItem.Info): string {
  return `retry attempts exhausted after ${item.attempt} attempts; Owner escalation required`;
}

export function hasRetryExhaustionBlocker(item: WorkItem.Info): boolean {
  return item.blockers.some(
    (blocker: WorkItem.Blocker) =>
      blocker.resolvedAt === undefined &&
      blocker.kind === "waiting_input" &&
      blocker.description === retryExhaustionDescription(item),
  );
}
