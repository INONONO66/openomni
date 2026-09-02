import type { Placement } from "@openomni/placement";
import type { Tool } from "@openomni/protocol";
import { ToolRefused, type AnyToolDefinition, type ToolExecutionContext } from "./define";
import { toolSpec } from "./project";

export const MODEL_OUTPUT_MAX_CHARS = 32_000;
export const HOST_TARGET: Placement.ToolTarget = { kind: "host", capabilities: [] };

type DispatchErrorClass =
  | "unknown_tool"
  | "invalid_input"
  | "precondition_failed"
  | "execution_failed"
  | "invalid_output";

type DispatchResult = Tool.Result & { readonly errorClass?: DispatchErrorClass };
type CellDispatchResult = Omit<DispatchResult, "output"> & { readonly output: unknown };

export interface Dispatcher {
  readonly specs: Tool.Spec[];
  readonly execute: (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<DispatchResult>;
  readonly executeCell: (
    call: Tool.Call,
    context?: Tool.ExecutionContext,
  ) => Promise<CellDispatchResult>;
}

function failed(call: Tool.Call, output: string, errorClass: DispatchErrorClass): DispatchResult {
  return {
    toolCallId: call.id,
    id: call.id,
    toolName: call.tool,
    output,
    isError: true,
    errorClass,
  };
}

function issueMessage(issue: { readonly path: PropertyKey[]; readonly message: string }): string {
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

function executionContext(
  call: Tool.Call,
  context: Tool.ExecutionContext | undefined,
  sessionId: string,
): ToolExecutionContext {
  return {
    sessionId: context?.traceContext?.sessionId ?? sessionId,
    ...(context?.traceContext?.runId === undefined ? {} : { turnId: context.traceContext.runId }),
    callId: call.id,
    signal: context?.signal ?? new AbortController().signal,
  };
}

function truncate(output: string): string {
  if (output.length <= MODEL_OUTPUT_MAX_CHARS) return output;
  return `${output.slice(0, MODEL_OUTPUT_MAX_CHARS)}\n[truncated: ${MODEL_OUTPUT_MAX_CHARS} of ${output.length} chars]`;
}

export function createDispatcher(
  definitions: readonly AnyToolDefinition[],
  sessionId = "unknown-session",
): Dispatcher {
  const known = new Map(definitions.map((definition) => [definition.name, definition]));

  async function dispatch(
    call: Tool.Call,
    door: "model" | "cell",
    context?: Tool.ExecutionContext,
  ): Promise<DispatchResult | CellDispatchResult> {
    const definition = known.get(call.tool);
    if (definition === undefined) return failed(call, `unknown tool: ${call.tool}`, "unknown_tool");

    const input = definition.input.safeParse(call.input);
    if (!input.success) {
      const reason = issueMessage(input.error.issues[0] ?? { path: [], message: "invalid input" });
      return failed(call, `${definition.name} refused: ${reason}`, "invalid_input");
    }

    let value: unknown;
    try {
      value = await definition.execute(
        input.data as never,
        executionContext(call, context, sessionId),
      );
    } catch (error) {
      return error instanceof ToolRefused
        ? failed(call, error.message, "precondition_failed")
        : failed(call, error instanceof Error ? error.message : String(error), "execution_failed");
    }

    const output = definition.output.safeParse(value);
    if (!output.success) {
      return failed(call, `${definition.name} produced invalid output`, "invalid_output");
    }

    return {
      toolCallId: call.id,
      id: call.id,
      toolName: call.tool,
      output:
        door === "cell"
          ? output.data
          : truncate(definition.render(input.data as never, output.data as never)),
    };
  }

  return {
    specs: definitions.filter((definition) => definition.visibility.model.length > 0).map(toolSpec),
    execute: (call, context) => dispatch(call, "model", context) as Promise<DispatchResult>,
    executeCell: (call, context) => dispatch(call, "cell", context),
  };
}
