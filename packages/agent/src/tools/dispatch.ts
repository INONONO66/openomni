import type { ToolResult } from "@openomni/protocol";
import { IngressEngine } from "../ingress/engine";
import {
  ExecutionSupervisor,
  type DispatchContext,
  type DispatchExecutionInput,
  type DispatchOutput,
  type DispatchReviewDecision,
  type DispatchReviewInput,
  type DispatchTask,
} from "../loop/execution-supervisor";
import { DispatchInput } from "./schemas";

export type { DispatchContext, DispatchReviewDecision, DispatchReviewInput };

export namespace Dispatch {
  export async function execute(
    toolCallId: string,
    rawInput: unknown,
    context: DispatchContext,
  ): Promise<ToolResult> {
    const parseResult = DispatchInput.safeParse(rawInput);
    if (!parseResult.success) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Invalid dispatch input: ${parseResult.error.message}`,
        isError: true,
      };
    }

    const input = parseResult.data;

    if (context.insideDelegation) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output:
          "Nested delegation not allowed: dispatch child cannot call subagent/dispatch",
        isError: true,
      };
    }

    try {
      const output = await executeDispatch(input, context);

      for (const result of output.results) {
        const eventName =
          result.status === "completed"
            ? "subagent.completed"
            : "subagent.failed";

        IngressEngine.ingest({
          id: crypto.randomUUID(),
          surface: "internal",
          name: eventName,
          payload: {
            taskId: result.id,
            summary: result.summary,
            error: result.error,
          },
          meta: {
            originTaskId: result.childTaskId,
            executionContext: "task",
            resultSummary: result.summary,
          },
          occurredAt: new Date().toISOString(),
        }).catch((error) => {
          console.error(
            `[Dispatch] Failed to emit completion event for task ${result.id} (${eventName}):`,
            error,
          );
        });
      }

      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: JSON.stringify(output),
        isError: !output.success,
      };
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        toolCallId,
        output: `Dispatch execution error: ${toErrorMessage(error)}`,
        isError: true,
      };
    }
  }
}

export async function executeDispatch(
  input: DispatchInput,
  context: DispatchContext,
): Promise<DispatchOutput> {
  const supervisorInput: DispatchExecutionInput = {
    objective: input.objective,
    tasks: input.tasks.map(
      (task): DispatchTask => ({
        id: task.id,
        description: task.description,
        agentType: task.agentType,
        dependencies: [...task.dependencies],
        fileScope: [...task.fileScope],
      }),
    ),
  };

  return ExecutionSupervisor.executeDispatch(supervisorInput, context);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
