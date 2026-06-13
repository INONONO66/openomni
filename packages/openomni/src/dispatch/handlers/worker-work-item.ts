import type { Dispatch, WorkItem } from "@openomni/protocol";
import { WorkItemStore } from "@openomni/session";
import { ignoreWorkItemReflectionFailure } from "./worker-completion.js";

export type WorkerWorkItemRequest = {
  readonly prompt: string;
  readonly agentName?: string;
  readonly sessionId?: string;
};

export type WorkerSpawnLedgerPayload = {
  readonly acceptanceCriteria: string[];
  readonly constraints?: string[];
};

export async function createWorkerSpawnWorkItem(
  command: Dispatch.Command,
  request: WorkerWorkItemRequest,
  payload: WorkerSpawnLedgerPayload,
  executorKind: WorkItem.ExecutorKind,
): Promise<string> {
  const workItem = await WorkItemStore.create({
    name: `Dispatch worker ${request.agentName ?? "worker"}`,
    sourceMessageId: command.dispatchId,
    sourceChannel: "dispatch",
    intent: command.action,
    goal: request.prompt,
    assigneeId: request.agentName,
    sessionId: request.sessionId,
    executorKind,
    context: command.sessionId ? `originSessionId=${command.sessionId}` : undefined,
    constraints: payload.constraints,
    acceptanceCriteria: payload.acceptanceCriteria,
  });
  await WorkItemStore.start(workItem.hash);
  return workItem.hash;
}

export async function failUnsupportedWorkerExecutor(
  workItemHash: string,
  executorKind: WorkItem.ExecutorKind,
): Promise<never> {
  const reason = `worker.spawn executor ${executorKind} is not wired`;
  return failWorkerSpawnExecutor(workItemHash, executorKind, reason);
}

export async function failWorkerSpawnExecutor(
  workItemHash: string,
  executorKind: WorkItem.ExecutorKind,
  reason: string,
): Promise<never> {
  await ignoreWorkItemReflectionFailure(() =>
    WorkItemStore.addEvidence(workItemHash, {
      kind: "custom",
      description: reason,
      passed: false,
      detail: `executorKind=${executorKind}`,
    }),
  );
  await ignoreWorkItemReflectionFailure(() => WorkItemStore.fail(workItemHash, reason));
  throw new Error(reason);
}
