import type { Execution } from "@openomni/protocol";
import {
  reflectCoordinatorResult,
  type CompletionReflection,
  type WorkerCompletionOptions,
} from "./worker-completion.js";
import { recordWorkerEvidence, type WorkerLedgerBinding } from "./worker-work-item.js";

export interface ConnectorCompletionProjection {
  readonly reflection: CompletionReflection;
}

export async function projectConnectorCompletion(
  binding: WorkerLedgerBinding,
  result: Execution.Result,
  options: WorkerCompletionOptions = {},
): Promise<ConnectorCompletionProjection> {
  const ledger = options.ledger;
  if (!ledger) throw new Error("connector completion requires worker ledger service");
  for (const artifact of result.artifacts ?? []) {
    await recordWorkerEvidence(ledger, binding, {
      kind: "custom",
      description: "connector log artifact recorded",
      passed: true,
      detail: artifact,
    });
  }
  for (const event of result.logEvents ?? []) {
    await recordWorkerEvidence(ledger, binding, {
      kind: "custom",
      description: "connector log event recorded",
      passed: true,
      detail: event,
    });
  }
  if (result.usage !== undefined) {
    await recordWorkerEvidence(ledger, binding, {
      kind: "custom",
      description: "connector token usage recorded",
      passed: true,
      detail: result.usage,
    });
  }
  for (const event of result.logEvents ?? []) {
    const toolCall = event.toolCall;
    if (toolCall === undefined) continue;
    await recordWorkerEvidence(ledger, binding, {
      kind: "custom",
      description: "connector tool call recorded",
      passed: toolCall.status !== "failed" && toolCall.status !== "error",
      detail: toolCall,
    });
  }
  const reflection = await reflectCoordinatorResult(binding, result, options);
  return { reflection };
}
