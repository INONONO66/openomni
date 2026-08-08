import {
  policyKernelVersion,
  WorkItem,
  type Dispatch,
  type Model,
  type Policy,
} from "@openomni/protocol";
import { WorkItemStore } from "@openomni/session";

export type WorkerWorkItemRequest = {
  readonly prompt: string;
  readonly agentName?: string;
  readonly sessionId?: string;
  readonly runId?: string;
};

export type WorkerSpawnAttemptMaterials = {
  readonly model: Model.Ref;
  readonly policyPlan?: Policy.PolicyPlan;
  readonly workspaceRoot?: string;
};

function absent(reason: string): { absent: true; reason: string } {
  return { absent: true, reason };
}

/**
 * #510 C2 — allocates the Attempt identity for a spawned worker BEFORE the
 * executor acts (both the WorkerRun record and the dispatch happen after
 * this durable append). Fingerprints are computed HERE, at the kernel spawn
 * site, from the materials in hand (model ref, executor kind, policy plan
 * labels, workspace root; environment: bun/platform/arch plus cheaply
 * available schema/policy versions). Declared best-effort inputs the spawn
 * site cannot supply are absent-but-listed with a reason — never silently
 * empty. Returns the attemptId threaded alongside the existing workerRunId.
 */
export async function allocateWorkerSpawnAttempt(
  workItemHash: string,
  prompt: string,
  executorKind: WorkItem.ExecutorKind,
  materials: WorkerSpawnAttemptMaterials,
): Promise<string> {
  const contentFingerprint = WorkItem.contentFingerprintOf({
    workInput: prompt,
    handlerKind: executorKind,
    handlerCodeRef: absent(
      "handler code identity is not captured at the spawn site (#510 phase D)",
    ),
    model: {
      provider: materials.model.provider,
      id: materials.model.id,
      parameters: absent("no model parameters are configured at dispatch"),
    },
    upstreamFingerprints: absent(
      "upstream attempt consumption is not tracked at the spawn site (#510 phase D)",
    ),
    dependencyLock: absent("dependency-lock identity is not read at the spawn site (#510 phase D)"),
  });
  const environmentFingerprint = WorkItem.environmentFingerprintOf({
    os: process.platform,
    arch: process.arch,
    bunVersion: process.versions.bun ?? process.version,
    workspaceRoot:
      materials.workspaceRoot ?? absent("the dispatch command carries no workspaceRoot"),
    schemaVersions: { policyKernel: policyKernelVersion },
    policy: materials.policyPlan
      ? {
          labels: [...materials.policyPlan.labels].sort(),
          ...(materials.policyPlan.registryVersion === undefined
            ? {}
            : { registryVersion: materials.policyPlan.registryVersion }),
        }
      : absent("no policy plan is resolved for this spawn target"),
    toolVersions: absent("tool versions are not enumerated at the spawn site (#510 phase D)"),
    verifierVersions: absent(
      "verifier versions are not enumerated at the spawn site (#510 phase D)",
    ),
    providerParameters: absent("no provider parameters are configured at dispatch"),
    configRef: absent("no redacted config identity exists at the spawn site (#510 phase D)"),
  });
  const allocation = await WorkItemStore.allocateAttempt(workItemHash, {
    contentFingerprint,
    environmentFingerprint,
  });
  if (!allocation) {
    throw new Error(`WorkItem not found for attempt allocation: ${workItemHash}`);
  }
  return allocation.attempt.attemptId;
}

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
  const failure = new Error(reason);
  try {
    await WorkItemStore.addEvidence(workItemHash, {
      kind: "custom",
      description: reason,
      passed: false,
      detail: `executorKind=${executorKind}`,
    });
    await WorkItemStore.fail(workItemHash, reason);
  } catch (reflectionFailure) {
    throwWithWorkItemReflectionFailure(failure, reflectionFailure);
  }
  throw failure;
}

class WorkItemReflectionError extends Error {
  readonly reflectionFailure: unknown;

  constructor(primary: Error, reflectionFailure: unknown) {
    super(primary.message, { cause: primary });
    this.name = "WorkItemReflectionError";
    this.reflectionFailure = reflectionFailure;
  }
}

export function throwWithWorkItemReflectionFailure(
  primaryFailure: unknown,
  reflectionFailure: unknown,
): never {
  const primary =
    primaryFailure instanceof Error ? primaryFailure : new Error(String(primaryFailure));
  throw new WorkItemReflectionError(primary, reflectionFailure);
}
