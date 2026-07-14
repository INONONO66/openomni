import {
  publishChildAgentCancelled,
  publishChildAgentCompleted,
  publishChildAgentFailed,
} from "./events.js";
import type { DelegationPolicyRuntime } from "./policy.js";
import { snapshot, type ChildAgentRuntimeOptions, type ChildRecord } from "./types.js";

function enqueueCompletion(options: ChildAgentRuntimeOptions, record: ChildRecord): void {
  const parentRunId = options.traceContext?.runId;
  if (!record.notifyOnComplete || !options.injectionQueue || !parentRunId) return;
  const child = snapshot(record);
  const output =
    child.status === "completed"
      ? (child.output ?? "")
      : "Child agent finished with status failed. Await or inspect the child for details.";
  options.injectionQueue.enqueue(parentRunId, {
    messageId: crypto.randomUUID(),
    output: `[child_agent ${record.id} ${child.status}]\n${output}`,
    injectToHistory: true,
    timestamp: Date.now(),
  });
}

export async function settleCompleted(
  options: ChildAgentRuntimeOptions,
  policy: DelegationPolicyRuntime,
  record: ChildRecord,
  result: NonNullable<ChildRecord["result"]>,
): Promise<void> {
  if (record.status !== "running") return;
  record.result = result;
  record.status = "completed";
  publishChildAgentCompleted(options, record);
  enqueueCompletion(options, record);
  await policy.dispatchPost(record.id, { status: "completed", result });
}

export async function settleFailed(
  options: ChildAgentRuntimeOptions,
  policy: DelegationPolicyRuntime,
  record: ChildRecord,
  error: unknown,
): Promise<void> {
  if (record.status !== "running") return;
  record.error = error instanceof Error ? error.message : String(error);
  record.status = "failed";
  publishChildAgentFailed(options, record);
  enqueueCompletion(options, record);
  await policy.dispatchPost(record.id, { status: "failed", error: record.error });
}

export async function settleCancelled(
  options: ChildAgentRuntimeOptions,
  policy: DelegationPolicyRuntime,
  record: ChildRecord,
  reason: Error,
): Promise<void> {
  if (record.status !== "running") return;
  record.status = "cancelled";
  record.controller.abort(reason);
  publishChildAgentCancelled(options, record);
  await policy.dispatchPost(record.id, { status: "cancelled", reason: reason.message });
}
