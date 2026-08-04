import type { Dispatch, WorkItem } from "@openomni/protocol";
import { WorkItemStore } from "@openomni/session";

export type WorkerWorkItemRequest = {
  readonly prompt: string;
  readonly agentName?: string;
  readonly sessionId?: string;
  readonly runId?: string;
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
    originSessionId: command.sessionId,
    workSessionId: request.sessionId,
    workerRunId: request.runId,
    executorKind,
    context: command.sessionId ? `originSessionId=${command.sessionId}` : undefined,
    constraints: payload.constraints,
    acceptanceCriteria: payload.acceptanceCriteria,
  });
  await WorkItemStore.start(workItem.hash);
  return workItem.hash;
}

export async function failWorkerSpawnExecutor(
  workItemHash: string,
  executorKind: WorkItem.ExecutorKind,
  reason: string,
): Promise<never> {
  await WorkItemStore.addEvidence(workItemHash, {
    kind: "custom",
    description: reason,
    passed: false,
    detail: `executorKind=${executorKind}`,
  });
  await WorkItemStore.fail(workItemHash, reason);
  throw new Error(reason);
}
