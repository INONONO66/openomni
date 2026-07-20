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
      : `Child agent finished with status ${child.status}. Await or inspect the child for details.`;
  options.injectionQueue.enqueue(parentRunId, {
    messageId: crypto.randomUUID(),
    output: `[child_agent ${record.id} ${child.status}]\n${output}`,
    injectToHistory: true,
    timestamp: Date.now(),
  });
}

async function dispatchTerminalAudit(
  policy: DelegationPolicyRuntime,
  record: ChildRecord,
  result:
    | { readonly status: "completed"; readonly result: NonNullable<ChildRecord["result"]> }
    | { readonly status: "failed"; readonly error: string }
    | { readonly status: "cancelled"; readonly reason: string },
): Promise<void> {
  try {
    await policy.dispatchPost(record.id, result);
  } catch {
    // Terminal state is authoritative; an unavailable audit policy must not undo settlement.
  }
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
  await dispatchTerminalAudit(policy, record, { status: "completed", result });
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
  await dispatchTerminalAudit(policy, record, { status: "failed", error: record.error });
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
  enqueueCompletion(options, record);
  await dispatchTerminalAudit(policy, record, { status: "cancelled", reason: reason.message });
}
