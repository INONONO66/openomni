import { createHash } from "node:crypto";
import type { Dispatch, Execution, Ledger, WorkItem } from "@openomni/protocol";

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

/**
 * Kernel semantic request. The server-held implementation resolves DB time, authoritative heads,
 * authenticated identity, snapshots/content refs, and the exact closed per-family fact bundle.
 */
export interface WorkerLedgerSemanticRequestV1 {
  readonly transitionId: Execution.NativeTransitionIdV1;
  readonly requestId: string;
  readonly requestHash: string;
  readonly target: WorkerLedgerBinding;
  readonly evidenceRef?: string;
  readonly content?: unknown;
  /** Exact binding returned by the atomic intent commit; required for EF settlement transitions. */
  readonly effectBinding?: WorkerSemanticEffectBindingV1;
}

export interface WorkerSemanticEffectBindingV1 {
  readonly effect: Ledger.EffectRefV1;
  readonly effectScope: Execution.EffectScopeV1;
}

export interface WorkerLedgerSemanticCommitResultV1 {
  readonly transitionResult: Execution.KernelTransitionResultV1;
  /** Present only when the same atomic commit created an external-effect intent. */
  readonly effectBinding?: WorkerSemanticEffectBindingV1;
}

export interface WorkerLedgerBinding {
  readonly owner: Ledger.OwnerV1;
  readonly workItemId: string;
  readonly runId: string;
  readonly attempt: Ledger.AttemptRefV1;
  readonly status: "draft" | "running" | "failed" | "cancelled" | "completed" | "archived";
  readonly evidenceRefs: readonly string[];
  readonly readbackRefs: readonly string[];
}

/**
 * Server-bound semantic ledger capability. It deliberately does not accept a protocol command:
 * identity, expected head, DB time, content refs, and strict fact-family bundles are server-owned.
 */
export interface WorkerLedgerService {
  commitSemanticTransition(
    request: WorkerLedgerSemanticRequestV1,
  ): Promise<WorkerLedgerSemanticCommitResultV1>;
  resolveWorkByRunId(runId: string): Promise<WorkerLedgerBinding | undefined>;
  resolveAttemptByRunId(runId: string): Promise<WorkerLedgerBinding | undefined>;
}

export async function createWorkerSpawnWorkItem(
  command: Dispatch.Command,
  request: WorkerWorkItemRequest,
  payload: WorkerSpawnLedgerPayload,
  executorKind: WorkItem.ExecutorKind,
  ledger: WorkerLedgerService,
): Promise<WorkerLedgerBinding> {
  if (!request.runId) throw new Error("worker.spawn requires a runId before ledger allocation");
  const workItemId = `work-${digest(command.dispatchId).slice(0, 32)}`;
  const attempt = {
    version: "attempt-ref-v1" as const,
    workItemId,
    attemptId: request.runId,
    attemptSeq: 1,
  };
  const binding: WorkerLedgerBinding = {
    owner: { version: "ledger-owner-v1", ownerKey: `work:${workItemId}` },
    workItemId,
    runId: request.runId,
    attempt,
    status: "draft",
    evidenceRefs: [],
    readbackRefs: [],
  };
  await commitWorkerLedgerTransition(ledger, binding, {
    transitionId: "DP-05",
    command: "kernel.dispatch.spawn_worker.v1",
    requestKey: command.dispatchId,
    facts: {
      name: `Dispatch worker ${request.agentName ?? "worker"}`,
      sourceMessageId: command.dispatchId,
      sourceChannel: "dispatch",
      intent: command.action,
      goal: request.prompt,
      assigneeId: request.agentName,
      sessionId: request.sessionId,
      originSessionId: command.sessionId,
      executorKind,
      constraints: payload.constraints,
      acceptanceCriteria: payload.acceptanceCriteria,
    },
  });
  return binding;
}

export async function failWorkerSpawnExecutor(
  binding: WorkerLedgerBinding,
  executorKind: WorkItem.ExecutorKind,
  reason: string,
  ledger: WorkerLedgerService,
): Promise<never> {
  await recordWorkerEvidence(ledger, binding, {
    description: reason,
    passed: false,
    detail: `executorKind=${executorKind}`,
  });
  await commitWorkerLedgerTransition(ledger, binding, {
    transitionId: "DP-10",
    command: "kernel.dispatch.fail_work.v1",
    requestKey: `${binding.runId}:failed`,
    facts: { reason },
  });
  throw new Error(reason);
}

export async function recordWorkerEvidence(
  ledger: WorkerLedgerService,
  binding: WorkerLedgerBinding,
  evidence: unknown,
): Promise<string> {
  const evidenceRef = digest(evidence);
  await commitWorkerLedgerTransition(ledger, binding, {
    transitionId: "WI-06",
    command: "kernel.work.record_evidence.v1",
    requestKey: `${binding.runId}:evidence:${evidenceRef}`,
    evidenceRef,
    facts: evidence,
  });
  return evidenceRef;
}

export async function commitWorkerLedgerTransition(
  ledger: WorkerLedgerService,
  binding: WorkerLedgerBinding,
  input: {
    readonly transitionId: Execution.NativeTransitionIdV1;
    readonly command: Execution.NativeCommandNameV1;
    readonly requestKey: string;
    readonly evidenceRef?: string;
    readonly facts?: unknown;
    readonly effectBinding?: WorkerSemanticEffectBindingV1;
  },
): Promise<WorkerSemanticEffectBindingV1 | undefined> {
  const requestHash = digest({
    transitionId: input.transitionId,
    target: {
      owner: binding.owner,
      workItemId: binding.workItemId,
      runId: binding.runId,
      attempt: binding.attempt,
    },
    evidenceRef: input.evidenceRef,
    content: input.facts,
    effectBinding: input.effectBinding,
  });
  const result = await ledger.commitSemanticTransition({
    transitionId: input.transitionId,
    requestId: input.requestKey,
    requestHash,
    target: binding,
    ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
    ...(input.facts === undefined ? {} : { content: input.facts }),
    ...(input.effectBinding ? { effectBinding: input.effectBinding } : {}),
  });
  if (result.transitionResult.status === "rejected") {
    throw new Error(`${input.command} rejected: ${result.transitionResult.code}`);
  }
  return result.effectBinding;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
