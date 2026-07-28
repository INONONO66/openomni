import type { Execution } from "@openomni/protocol";
import { WorkItemStore } from "@openomni/session";
import {
  ignoreWorkItemReflectionFailure,
  reflectCoordinatorResult,
  type CompletionReflection,
  type WorkerCompletionOptions,
} from "./worker-completion.js";

export interface ConnectorCompletionProjection {
  readonly reflection: CompletionReflection;
}

export async function projectConnectorCompletion(
  workItemHash: string,
  result: Execution.Result,
  options: WorkerCompletionOptions = {},
): Promise<ConnectorCompletionProjection> {
  await recordConnectorArtifacts(workItemHash, result);
  await recordConnectorLogEvents(workItemHash, result);
  await recordConnectorTokenUsage(workItemHash, result);
  await recordConnectorToolCalls(workItemHash, result);
  const reflection = await reflectCoordinatorResult(workItemHash, result, options);
  return { reflection };
}

async function recordConnectorArtifacts(
  workItemHash: string,
  result: Execution.Result,
): Promise<void> {
  for (const artifact of result.artifacts ?? []) {
    await ignoreWorkItemReflectionFailure(() =>
      WorkItemStore.addEvidence(workItemHash, {
        kind: "custom",
        description: "connector log artifact recorded",
        passed: true,
        detail: JSON.stringify(artifact),
      }),
    );
  }
}

async function recordConnectorLogEvents(
  workItemHash: string,
  result: Execution.Result,
): Promise<void> {
  for (const event of result.logEvents ?? []) {
    await ignoreWorkItemReflectionFailure(() =>
      WorkItemStore.addEvidence(workItemHash, {
        kind: "custom",
        description: "connector log event recorded",
        passed: true,
        detail: JSON.stringify(event),
      }),
    );
  }
}

async function recordConnectorTokenUsage(
  workItemHash: string,
  result: Execution.Result,
): Promise<void> {
  if (result.usage === undefined) return;
  await ignoreWorkItemReflectionFailure(() =>
    WorkItemStore.addEvidence(workItemHash, {
      kind: "custom",
      description: "connector token usage recorded",
      passed: true,
      detail: JSON.stringify(result.usage),
    }),
  );
}

async function recordConnectorToolCalls(
  workItemHash: string,
  result: Execution.Result,
): Promise<void> {
  for (const event of result.logEvents ?? []) {
    const toolCall = event.toolCall;
    if (toolCall === undefined) continue;
    await ignoreWorkItemReflectionFailure(() =>
      WorkItemStore.addEvidence(workItemHash, {
        kind: "custom",
        description: "connector tool call recorded",
        passed: toolCall.status !== "failed" && toolCall.status !== "error",
        detail: JSON.stringify(toolCall),
      }),
    );
  }
}
