import {
  type AnyToolDefinition,
  type BusEvent,
  Tool,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@openomni/protocol";
import { z } from "zod";

export const MODEL_OUTPUT_MAX_CHARS = 32_000;

export class ToolRefused extends Error {
  constructor(toolName: string, reason: string) {
    super(`${toolName} refused: ${reason}`);
    this.name = "ToolRefused";
  }
}

/** The single owner of the replay-safety derivation. */
export function toolIsSafe(category: ToolDefinition<z.ZodType, z.ZodType>["category"]): boolean {
  return category === "query";
}

export type ToolErrorKind =
  | "unknown_tool"
  | "invalid_input"
  | "precondition_failed"
  | "execution_failed"
  | "invalid_output";

export type ToolDispatchResult = Tool.Result & { readonly errorKind?: ToolErrorKind };
export type CellToolDispatchResult = Omit<ToolDispatchResult, "output"> & {
  readonly output: unknown;
};

export interface ToolPostInput {
  readonly call: Tool.Call;
  readonly output: unknown;
  readonly context: ToolExecutionContext;
}

export type ToolPostResult =
  | unknown
  | { readonly transform: "redact"; readonly paths: readonly string[] };
export type ToolPostPolicy = (input: ToolPostInput) => Promise<ToolPostResult>;

export interface ToolExecutionCommitter {
  intent(call: Tool.Call, context: ToolExecutionContext): Promise<void>;
  result(
    call: Tool.Call,
    context: ToolExecutionContext,
    result: ToolDispatchResult | CellToolDispatchResult,
  ): Promise<void>;
}

export interface ToolExecutionObservation extends BusEvent.Sink {}

export interface DispatcherOptions {
  readonly post?: ToolPostPolicy;
  readonly commits?: ToolExecutionCommitter;
  readonly observations?: ToolExecutionObservation;
  readonly clock?: () => number;
  readonly timeoutMs?: number;
}

export interface Dispatcher {
  readonly specs: readonly Tool.Spec[];
  execute(call: Tool.Call, context: ToolExecutionContext): Promise<ToolDispatchResult>;
  executeCell(call: Tool.Call, context: ToolExecutionContext): Promise<CellToolDispatchResult>;
}

export function defineTool<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
): ToolDefinition<In, Out> {
  if (definition.name.trim() === "") throw new Error("tool name must not be empty");
  if (definition.description.trim() === "") throw new Error("tool description must not be empty");
  if (toolInputSchema(definition).type !== "object") {
    throw new Error(`${definition.name} input schema root must be an object`);
  }
  return definition;
}

export function eraseTool<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
): AnyToolDefinition {
  return definition as AnyToolDefinition;
}

export function toolInputSchema(definition: AnyToolDefinition): Record<string, unknown> {
  const { $schema: _dialect, ...projected } = z.toJSONSchema(definition.input, {
    io: "input",
    target: "draft-7",
  }) as Record<string, unknown>;
  if (projected.type !== "object") {
    throw new Error(`${definition.name} input schema root must be an object`);
  }
  return projected;
}

export function createDispatcher(
  definitions: readonly AnyToolDefinition[],
  options: DispatcherOptions = {},
): Dispatcher {
  const known = new Map(definitions.map((definition) => [definition.name, definition]));
  const clock = options.clock ?? Date.now;

  async function dispatch(
    call: Tool.Call,
    context: ToolExecutionContext,
    door: "model" | "cell",
  ): Promise<ToolDispatchResult | CellToolDispatchResult> {
    const definition = known.get(call.tool);
    if (definition === undefined) return failed(call, `unknown tool: ${call.tool}`, "unknown_tool");
    const parsedInput = definition.input.safeParse(call.input);
    if (!parsedInput.success) {
      const issue = parsedInput.error.issues[0];
      const path = issue?.path.map(String).join(".") ?? "";
      const reason = issue === undefined ? "invalid input" : path === "" ? issue.message : `${path}: ${issue.message}`;
      return failed(call, `${definition.name} refused: ${reason}`, "invalid_input");
    }

    await options.commits?.intent(call, context);
    const startedAt = clock();
    options.observations?.publish(Tool.Events.Started, {
      traceId: context.turnId,
      sessionId: context.sessionId,
      runId: context.turnId,
      toolCallId: context.callId,
      toolName: definition.name,
      time: startedAt,
    });

    const execution = executeDefinition(definition, parsedInput.data, context, options.timeoutMs);
    const outcome = await execution;
    if (outcome.timedOut) {
      const result = failed(call, `${definition.name} timed out`, "execution_failed");
      await options.commits?.result(call, context, result);
      options.observations?.publish(Tool.Events.TimedOut, {
        traceId: context.turnId,
        sessionId: context.sessionId,
        runId: context.turnId,
        toolCallId: context.callId,
        toolName: definition.name,
        time: clock(),
        timeoutMs: options.timeoutMs ?? 0,
      });
      return result;
    }
    if (outcome.error !== undefined) {
      const result = failed(
        call,
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        isToolRefusal(outcome.error) ? "precondition_failed" : "execution_failed",
      );
      await complete(call, context, result, startedAt, definition.name);
      return result;
    }

    const parsedOutput = definition.output.safeParse(outcome.value);
    if (!parsedOutput.success) {
      const result = failed(call, `${definition.name} produced invalid output`, "invalid_output");
      await complete(call, context, result, startedAt, definition.name);
      return result;
    }

    const transformed = await applyPost(options.post, call, context, parsedOutput.data);
    const checked = definition.output.safeParse(transformed);
    if (!checked.success) {
      const result = failed(call, `${definition.name} produced invalid output`, "invalid_output");
      await complete(call, context, result, startedAt, definition.name);
      return result;
    }

    const result = {
      toolCallId: call.id,
      id: call.id,
      toolName: call.tool,
      output:
        door === "cell"
          ? checked.data
          : truncate(definition.render(parsedInput.data, checked.data)),
    } satisfies ToolDispatchResult | CellToolDispatchResult;
    await complete(call, context, result, startedAt, definition.name);
    return result;
  }

  async function complete(
    call: Tool.Call,
    context: ToolExecutionContext,
    result: ToolDispatchResult | CellToolDispatchResult,
    startedAt: number,
    toolName: string,
  ): Promise<void> {
    await options.commits?.result(call, context, result);
    options.observations?.publish(Tool.Events.Completed, {
      traceId: context.turnId,
      sessionId: context.sessionId,
      runId: context.turnId,
      toolCallId: context.callId,
      toolName,
      time: clock(),
      durationMs: Math.max(0, clock() - startedAt),
      isError: result.isError ?? false,
    });
  }

  return {
    specs: definitions
      .filter((definition) => definition.visibility.model.length > 0)
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: toolInputSchema(definition),
        safe: definition.category === "query",
      })),
    execute: (call, context) => dispatch(call, context, "model") as Promise<ToolDispatchResult>,
    executeCell: (call, context) =>
      dispatch(call, context, "cell") as Promise<CellToolDispatchResult>,
  };
}

async function executeDefinition(
  definition: AnyToolDefinition,
  input: unknown,
  context: ToolExecutionContext,
  timeoutMs: number | undefined,
): Promise<{ readonly timedOut: boolean; readonly value?: unknown; readonly error?: unknown }> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(context.signal.reason);
  context.signal.addEventListener("abort", forwardAbort, { once: true });
  const scopedContext = { ...context, signal: controller.signal };
  const execution = Promise.resolve(definition.execute(input, scopedContext)).then(
    (value) => ({ timedOut: false, value }) as const,
    (error: unknown) => ({ timedOut: false, error }) as const,
  );
  if (timeoutMs === undefined) return execution.finally(() => context.signal.removeEventListener("abort", forwardAbort));
  const timeout = Promise.withResolvers<{ readonly timedOut: true }>();
  const timer = setTimeout(() => {
    controller.abort(new Error(`tool timed out after ${timeoutMs}ms`));
    timeout.resolve({ timedOut: true });
  }, timeoutMs);
  return Promise.race([execution, timeout.promise]).finally(() => {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", forwardAbort);
  });
}

async function applyPost(
  post: ToolPostPolicy | undefined,
  call: Tool.Call,
  context: ToolExecutionContext,
  output: unknown,
): Promise<unknown> {
  if (post === undefined) return output;
  const decision = await post({ call, context, output });
  if (!isRedactTransform(decision)) return decision;
  return redact(output, decision.paths);
}

function isRedactTransform(
  value: unknown,
): value is { readonly transform: "redact"; readonly paths: readonly string[] } {
  if (value === null || typeof value !== "object") return false;
  const transform = Reflect.get(value, "transform");
  const paths = Reflect.get(value, "paths");
  return transform === "redact" && Array.isArray(paths) && paths.every((path) => typeof path === "string");
}

function redact(value: unknown, paths: readonly string[]): unknown {
  const copy = structuredClone(value);
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) return copy;
  const record = copy as Record<string, unknown>;
  for (const path of paths) delete record[path];
  return copy;
}

function failed(call: Tool.Call, output: string, errorKind: ToolErrorKind): ToolDispatchResult {
  return {
    toolCallId: call.id,
    id: call.id,
    toolName: call.tool,
    output,
    isError: true,
    errorKind,
  };
}

function isToolRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === "ToolRefused";
}

function truncate(output: string): string {
  if (output.length <= MODEL_OUTPUT_MAX_CHARS) return output;
  const marker = `\n[truncated: ${output.length} chars]`;
  return `${output.slice(0, MODEL_OUTPUT_MAX_CHARS - marker.length)}${marker}`;
}
