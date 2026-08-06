import type { Execution } from "@openomni/protocol";
import { WorkItemStore } from "@openomni/session";
import {
  reflectCoordinatorResult,
  requireWorkerCompletionIdentity,
  type CompletionReflection,
  type WorkerCompletionOptions,
} from "./worker-completion.js";

export interface ConnectorCompletionProjection {
  readonly reflection: CompletionReflection;
}

export type ConnectorCompletionOptions = Omit<WorkerCompletionOptions, "sourceOrigin">;

export async function projectConnectorCompletion(
  workItemHash: string,
  result: Execution.Result,
  options: ConnectorCompletionOptions,
): Promise<ConnectorCompletionProjection> {
  const item = requireWorkerCompletionIdentity(workItemHash, result);
  const expectedScope = {
    expectedAttempt: item.attempt,
    expectedBasisRef: item.completionContract.basisRef,
  };
  await recordConnectorArtifacts(workItemHash, result, expectedScope);
  await recordConnectorLogEvents(workItemHash, result, expectedScope);
  await recordConnectorTokenUsage(workItemHash, result, expectedScope);
  await recordConnectorToolCalls(workItemHash, result, expectedScope);
  const reflection = await reflectCoordinatorResult(workItemHash, result, {
    ...options,
    sourceOrigin: { source: "connector_worker" },
  });
  return { reflection };
}

async function recordConnectorArtifacts(
  workItemHash: string,
  result: Execution.Result,
  expectedScope: Readonly<{ expectedAttempt: number; expectedBasisRef: string }>,
): Promise<void> {
  for (const artifact of result.artifacts ?? []) {
    await WorkItemStore.addEvidence(
      workItemHash,
      {
        id: `connector:${result.runId}:artifact:${artifact.artifactId}`,
        kind: "custom",
        description: "connector log artifact recorded",
        passed: true,
        detail: JSON.stringify(artifact),
      },
      expectedScope,
    );
  }
}

async function recordConnectorLogEvents(
  workItemHash: string,
  result: Execution.Result,
  expectedScope: Readonly<{ expectedAttempt: number; expectedBasisRef: string }>,
): Promise<void> {
  for (const event of result.logEvents ?? []) {
    await WorkItemStore.addEvidence(
      workItemHash,
      {
        id: `connector:${result.runId}:log:${event.artifactId}:${event.sequence}`,
        kind: "custom",
        description: "connector log event recorded",
        passed: true,
        detail: JSON.stringify(event),
      },
      expectedScope,
    );
  }
}

async function recordConnectorTokenUsage(
  workItemHash: string,
  result: Execution.Result,
  expectedScope: Readonly<{ expectedAttempt: number; expectedBasisRef: string }>,
): Promise<void> {
  if (result.usage === undefined) return;
  await WorkItemStore.addEvidence(
    workItemHash,
    {
      id: `connector:${result.runId}:usage`,
      kind: "custom",
      description: "connector token usage recorded",
      passed: true,
      detail: JSON.stringify(result.usage),
    },
    expectedScope,
  );
}

async function recordConnectorToolCalls(
  workItemHash: string,
  result: Execution.Result,
  expectedScope: Readonly<{ expectedAttempt: number; expectedBasisRef: string }>,
): Promise<void> {
  for (const event of result.logEvents ?? []) {
    const toolCall = event.toolCall;
    if (toolCall === undefined) continue;
    await WorkItemStore.addEvidence(
      workItemHash,
      {
        id: `connector:${result.runId}:tool:${toolCall.id ?? `${event.artifactId}:${event.sequence}`}`,
        kind: "custom",
        description: "connector tool call recorded",
        passed: toolCall.status !== "failed" && toolCall.status !== "error",
        detail: JSON.stringify(toolCall),
      },
      expectedScope,
    );
  }
}
