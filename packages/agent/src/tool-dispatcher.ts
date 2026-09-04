import type { Placement } from "@openomni/placement";
import {
  type AnyToolDefinition,
  type BusEvent,
  type PlainObject,
  type PlainValue,
  PlainValueSchema,
  SessionGeneration,
  type Tool,
  type ToolCategory,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@openomni/protocol";
import { z } from "zod";
import {
  createToolExecutionObservationOwner,
  type ToolExecutionObservationOwner,
} from "./executor";

const MODEL_OUTPUT_MAX_CHARS = 32_000;
export const HOST_TARGET: Placement.ToolTarget = { kind: "host", capabilities: [] };

export class ToolRefused extends Error {
  constructor(toolName: string, reason: string) {
    super(`${toolName} refused: ${reason}`);
    this.name = "ToolRefused";
  }
}

/** The single owner of the replay-safety derivation. */
function toolIsSafe(category: ToolCategory): boolean {
  return category === "query";
}

type ToolErrorKind =
  | "unregistered_tool"
  | "invalid_input"
  | "precondition_failed"
  | "execution_failed"
  | "invalid_output";

type ToolDispatchResult = Tool.Result & { readonly errorKind?: ToolErrorKind };
type CellToolDispatchResult = Omit<ToolDispatchResult, "output"> & {
  readonly output: PlainValue;
};

interface ToolPostInput {
  readonly call: Tool.Call;
  readonly output: PlainValue;
  readonly context: ToolExecutionContext;
}

type ToolPostResult =
  | PlainValue
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
  readonly executionObservations?: ToolExecutionObservationOwner;
  readonly clock?: () => number;
  readonly timeoutMs?: number;
}

interface DispatchContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

export interface Dispatcher {
  readonly specs: readonly Tool.Spec[];
  execute(call: Tool.Call, context: DispatchContext): Promise<ToolDispatchResult>;
  executeCell(call: Tool.Call, context: DispatchContext): Promise<CellToolDispatchResult>;
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

type JsonSchemaObject = Record<string, PlainValue>;

export function toolInputSchema(definition: AnyToolDefinition): JsonSchemaObject {
  const { $schema: _dialect, ...projected } = z.toJSONSchema(definition.input, {
    io: "input",
    target: "draft-7",
  }) as JsonSchemaObject;
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
  const executionObservations =
    options.executionObservations ?? createToolExecutionObservationOwner(options.observations, clock);

  async function dispatch(
    call: Tool.Call,
    providedContext: DispatchContext,
    door: "model" | "cell",
  ): Promise<ToolDispatchResult | CellToolDispatchResult> {
    const context = executionContext(call, providedContext);
    const definition = known.get(call.tool);
    if (definition === undefined) {
      return failed(call, `unregistered tool: ${call.tool}`, "unregistered_tool");
    }
    const parsedInput = definition.input.safeParse(call.input);
    if (!parsedInput.success) {
      const issue = parsedInput.error.issues[0];
      const path = issue?.path.map(String).join(".") ?? "";
      const reason = issue === undefined ? "invalid input" : path === "" ? issue.message : `${path}: ${issue.message}`;
      return failed(call, `${definition.name} refused: ${reason}`, "invalid_input");
    }

    await options.commits?.intent(call, context);
    const startedAt = clock();
    executionObservations.started(call, context, definition.name, startedAt);

    const execution = executeDefinition(definition, parsedInput.data, context, options.timeoutMs);
    const outcome = await execution;
    if (outcome.timedOut) {
      const result = failed(call, `${definition.name} timed out`, "execution_failed");
      await options.commits?.result(call, context, result);
      executionObservations.timedOut(
        call,
        context,
        definition.name,
        options.timeoutMs ?? 0,
      );
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
    const jsonOutput = parsedOutput.success
      ? PlainValueSchema.safeParse(parsedOutput.data)
      : parsedOutput;
    if (!(parsedOutput.success && jsonOutput.success)) {
      const result = failed(call, `${definition.name} produced invalid output`, "invalid_output");
      await complete(call, context, result, startedAt, definition.name);
      return result;
    }

    const transformed = await applyPost(options.post, call, context, jsonOutput.data);
    const revalidated = definition.output.safeParse(transformed);
    const checked = revalidated.success ? PlainValueSchema.safeParse(transformed) : revalidated;
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
    executionObservations.completed(
      call,
      context,
      toolName,
      startedAt,
      result.isError ?? false,
    );
  }

  return {
    specs: definitions
      .filter((definition) => definition.visibility.model.length > 0)
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: toolInputSchema(definition),
        safe: toolIsSafe(definition.category),
        placement: "host",
      })),
    execute: (call, context) => dispatch(call, context, "model") as Promise<ToolDispatchResult>,
    executeCell: (call, context) =>
      dispatch(call, context, "cell") as Promise<CellToolDispatchResult>,
  };
}

export function sessionTool(definition: AnyToolDefinition): SessionGeneration.Tool {
  return SessionGeneration.Tool.parse({
    name: definition.name,
    inputSchema: toolInputSchema(definition),
    category: definition.category,
  });
}

export function toolSpec(definition: AnyToolDefinition): Tool.Spec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: toolInputSchema(definition),
    safe: toolIsSafe(definition.category),
    placement: "host",
  };
}

function executionContext(call: Tool.Call, context: DispatchContext): ToolExecutionContext {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    callId: call.id,
    signal: context.signal ?? new AbortController().signal,
  };
}

async function executeDefinition<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  input: z.output<In>,
  context: ToolExecutionContext,
  timeoutMs: number | undefined,
): Promise<{
  readonly timedOut: boolean;
  readonly value?: z.output<Out>;
  readonly error?: Error;
}> {
  if (timeoutMs === undefined) {
    return Promise.resolve(definition.execute(input, context)).then(
      (value) => ({ timedOut: false, value }) as const,
      (error) => ({ timedOut: false, error: toError(error) }) as const,
    );
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(context.signal.reason);
  context.signal.addEventListener("abort", forwardAbort, { once: true });
  const scopedContext = { ...context, signal: controller.signal };
  const execution = Promise.resolve(definition.execute(input, scopedContext)).then(
    (value) => ({ timedOut: false, value }) as const,
    (error) => ({ timedOut: false, error: toError(error) }) as const,
  );
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
  output: PlainValue,
): Promise<PlainValue> {
  if (post === undefined) return output;
  const decision = await post({ call, context, output });
  if (!isRedactTransform(decision)) return decision;
  return redact(output, decision.paths);
}

function isRedactTransform(
  value: ToolPostResult,
): value is { readonly transform: "redact"; readonly paths: readonly string[] } {
  if (value === null || typeof value !== "object") return false;
  const transform = Reflect.get(value, "transform");
  const paths = Reflect.get(value, "paths");
  return transform === "redact" && Array.isArray(paths) && paths.every((path) => typeof path === "string");
}

function redact(value: PlainValue, paths: readonly string[]): PlainValue {
  const copy = structuredClone(value);
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) return copy;
  const record: PlainObject = copy;
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

function isToolRefusal(error: Error): boolean {
  return error.name === "ToolRefused";
}

type CaughtValue = PlainValue | Error | bigint | symbol | undefined | ((...args: never[]) => void);

function toError(error: CaughtValue): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function truncate(output: string): string {
  if (output.length <= MODEL_OUTPUT_MAX_CHARS) return output;
  const marker = `\n[truncated: ${output.length} chars]`;
  return `${output.slice(0, MODEL_OUTPUT_MAX_CHARS - marker.length)}${marker}`;
}
