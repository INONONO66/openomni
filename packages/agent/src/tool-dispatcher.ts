import { executeToolBody, ToolBodyOutcome } from "./tool-body";
import type { Placement } from "@openomni/placement";
import { AsyncLocalStorage } from "node:async_hooks";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import {
  type AnyToolDefinition,
  type BusEvent,
  type LedgerSession,
  type ObservationSink,
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
  createExecutor,
  type ExecutionLedger,
  type Executor,
  type ExecutionBatchResult,
  type ExecutionRequest,
  type ExecutionApprovals,
  type ExecutorOptions,
} from "./executor";

const MODEL_OUTPUT_MAX_CHARS = 32_000;
export const HOST_TARGET: Placement.ToolTarget = { kind: "host", capabilities: [] };

export class ToolRefused extends Error {
  readonly errorKind = "precondition_failed";

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

export interface DispatcherOptions {
  readonly executor: Executor;
  readonly timeoutMs?: number;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly trackWave?: (wave: Promise<void>) => void;
}

interface DispatchContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

export interface Dispatcher {
  readonly executor?: Executor;
  readonly specs: readonly Tool.Spec[];
  execute(call: Tool.Call, context: DispatchContext): Promise<ToolDispatchResult>;
  executeWave(
    calls: readonly Tool.Call[],
    context: DispatchContext,
  ): Promise<readonly ToolDispatchResult[]>;
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

const activeExecutor = new AsyncLocalStorage<Executor>();

export class ExecutorContextError extends Error {
  readonly code = "executor_context_missing";

  constructor() {
    super("executor context is required");
    this.name = "ExecutorContextError";
  }
}

/**
 * The executor of the enclosing execution, for a consumer that must capture it
 * synchronously and inject it into a dispatcher invoked later out of context
 * (the code-mode cell door, whose kernel callbacks arrive after the run_code
 * turn has returned). Fails closed when called with no active execution.
 */
export function currentExecutor(): Executor {
  const executor = activeExecutor.getStore();
  if (executor === undefined) {
    throw new ExecutorContextError();
  }
  return executor;
}

export function createDispatcher(
  definitions: readonly AnyToolDefinition[],
  options?: DispatcherOptions,
): Dispatcher {
  /**
   * The cell door builds its dispatcher at tool-definition time, well ahead of every
   * execution context exists, so the ambient executor is resolved per dispatch:
   * an explicitly injected executor wins, otherwise the enclosing execution's
   * executor is inherited (nested cell tools), otherwise the dispatch fails
   * closed. Resolving once at construction would permanently capture
   * `undefined`; a definition-keyed cache would leak a stale executor from an
   * unrelated prior session into a context-less cell dispatch.
   */
  const resolveExecutor = (): Executor | undefined =>
    options?.executor ?? activeExecutor.getStore();
  const known = new Map(definitions.map((definition) => [definition.name, definition]));
  type Prepared =
    | { readonly kind: "refused"; readonly result: ToolDispatchResult }
    | {
        readonly kind: "ready";
        readonly request: ExecutionRequest;
        readonly body: () => Promise<PlainValue>;
        readonly sequential?: true;
        readonly finish: (
          result: ExecutionBatchResult,
        ) => ToolDispatchResult | CellToolDispatchResult;
      };
  function prepare(
    call: Tool.Call,
    providedContext: DispatchContext,
    door: "model" | "cell",
  ): Prepared {
    const context = executionContext(call, providedContext);
    const definition = known.get(call.tool);
    if (definition === undefined) {
      return {
        kind: "refused",
        result: failed(call, `unregistered tool: ${call.tool}`, "unregistered_tool"),
      };
    }
    const parsedInput = definition.input.safeParse(call.input);
    if (!parsedInput.success) {
      const issue = parsedInput.error.issues[0];
      const path = issue?.path.map(String).join(".") ?? "";
      const reason =
        issue === undefined
          ? "invalid input"
          : path === ""
            ? issue.message
            : `${path}: ${issue.message}`;
      return {
        kind: "refused",
        result: failed(call, `${definition.name} refused: ${reason}`, "invalid_input"),
      };
    }

    const executor = resolveExecutor();
    if (executor === undefined) {
      throw new ExecutorContextError();
    }
    const request: ExecutionRequest = {
      kind: "tool",
      op: definition.name,
      intent: PlainValueSchema.parse(parsedInput.data),
      effect: { category: definition.category },
      toolObservation: {
        turnId: context.turnId,
        callId: call.id,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
    };
    const body = () =>
      activeExecutor.run(executor, async () =>
        PlainValueSchema.parse(
          await executeToolBody(definition, parsedInput.data, context, options?.timeoutMs),
        ),
      );
    const finish = (
      execution: ExecutionBatchResult,
    ): ToolDispatchResult | CellToolDispatchResult => {
      if (execution.terminal === "cancelled")
        return failed(call, "tool execution cancelled", "execution_failed");
      if (execution.terminal === "failed")
        return failed(call, execution.error.message, "execution_failed");
      if (execution.terminal !== "executed") {
        const refusal = new ToolRefused(definition.name, execution.reason);
        if (door === "cell") throw refusal;
        return failed(call, refusal.message, "precondition_failed");
      }

      const parsedOutcome = ToolBodyOutcome.safeParse(execution.value);
      if (!parsedOutcome.success) {
        const result = failed(call, `${definition.name} produced invalid output`, "invalid_output");
        return result;
      }
      const outcome = parsedOutcome.data;
      if (outcome.status === "timed_out") {
        const result = failed(call, `${definition.name} timed out`, "execution_failed");
        return result;
      }
      if (outcome.status === "error") {
        const result = failed(call, outcome.message, outcome.errorKind);
        return result;
      }

      const transformedOutput = definition.output.safeParse(outcome.output);
      if (!transformedOutput.success) {
        const result = failed(call, `${definition.name} produced invalid output`, "invalid_output");
        return result;
      }
      const output = PlainValueSchema.safeParse(transformedOutput.data);
      if (!output.success) {
        const result = failed(call, `${definition.name} produced invalid output`, "invalid_output");
        return result;
      }
      const result = {
        toolCallId: call.id,
        id: call.id,
        toolName: call.tool,
        output:
          door === "cell"
            ? output.data
            : truncate(definition.render(parsedInput.data, output.data)),
      } satisfies ToolDispatchResult | CellToolDispatchResult;
      return result;
    };
    return {
      kind: "ready",
      request,
      body,
      finish,
      ...(definition.sequential ? { sequential: true } : {}),
    };
  }

  async function dispatch(call: Tool.Call, context: DispatchContext, door: "model" | "cell") {
    const prepared = prepare(call, context, door);
    if (prepared.kind === "refused") return prepared.result;
    const executor = resolveExecutor();
    if (executor === undefined) throw new ExecutorContextError();
    return prepared.finish(await executor.run(prepared.request, prepared.body));
  }

  function executeWave(
    calls: readonly Tool.Call[],
    context: DispatchContext,
  ): Promise<readonly ToolDispatchResult[]> {
    const execute = async (): Promise<readonly ToolDispatchResult[]> => {
      const prepared = calls.map((call) => prepare(call, context, "model"));
      const ready = prepared.filter(
        (item): item is Extract<Prepared, { kind: "ready" }> => item.kind === "ready",
      );
      const executor = resolveExecutor();
      if (executor?.runBatch === undefined) throw new ExecutorContextError();
      const results = await executor.runBatch(ready, {
        signal: context.signal ?? new AbortController().signal,
        retain: options?.retainEffect,
      });
      let index = 0;
      return prepared.map((item) => {
        if (item.kind === "refused") return item.result;
        const result = results[index++];
        if (result === undefined) throw new Error("wave result missing");
        const finished = item.finish(result);
        if (typeof finished.output !== "string")
          throw new Error("model tool output must be rendered text");
        return { ...finished, output: finished.output };
      });
    };
    const wave = Promise.resolve().then(execute);
    options?.trackWave?.(wave.then(() => undefined));
    return wave;
  }

  return {
    ...(options?.executor === undefined ? {} : { executor: options.executor }),
    specs: definitions.filter((definition) => definition.visibility.model.length > 0).map(toolSpec),
    executeWave,
    execute: (call, context) => dispatch(call, context, "model") as Promise<ToolDispatchResult>,
    executeCell: (call, context) =>
      dispatch(call, context, "cell") as Promise<CellToolDispatchResult>,
  };
}

/**
 * The per-turn identity and lease under which a dispatcher's tools commit.
 * Mirrors the fields both the resident and worker runners already pin on their
 * {@link SessionRunnerInput}, so composing the executor+dispatcher has one owner
 * instead of being copied per role.
 */
export interface TurnDispatchInput {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly actionId: string;
  readonly turnId?: string;
  readonly tools?: readonly SessionGeneration.Tool[];
  readonly toolsGeneration?: number;
  readonly toolsHash?: string;
  readonly policy: CompiledPolicySnapshot;
  readonly ledger: ExecutionLedger;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly trackWave?: (wave: Promise<void>) => void;
  readonly bindApprovals?: (approvals: ExecutionApprovals) => void;
}

/** The runtime clock/entropy/observation sink shared across a session's turns. */
export interface TurnDispatchRuntime {
  readonly approvalTimeoutMs?: ExecutorOptions["approvalTimeoutMs"];
  readonly scheduleApprovalTimeout?: ExecutorOptions["scheduleApprovalTimeout"];
  readonly observations: ObservationSink | BusEvent.Sink;
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly authorizeApproval?: ExecutorOptions["authorizeApproval"];
}

/**
 * Compose the per-turn executor and dispatcher for a prepared runner turn. Both
 * the resident and worker runners build this identically; keeping it here makes
 * "how a turn's tools commit durably" a single owner.
 */
export function createTurnDispatcher(
  definitions: readonly AnyToolDefinition[],
  input: TurnDispatchInput,
  runtime: TurnDispatchRuntime,
): Dispatcher & { readonly executor: Executor } {
  const executor = createExecutor({
    policy: input.policy,
    authorizeApproval: runtime.authorizeApproval,
    approvalTimeoutMs: runtime.approvalTimeoutMs,
    scheduleApprovalTimeout: runtime.scheduleApprovalTimeout,
    ledger: input.ledger,
    observations: runtime.observations,
    identity: {
      sessionId: input.sessionId,
      role: input.role,
      parentActionId: input.actionId,
      turnId: input.turnId,
      toolsGeneration: input.toolsGeneration,
      toolsHash: input.toolsHash,
    },
    clock: runtime.clock ?? Date.now,
    entropy: runtime.entropy ?? (() => crypto.randomUUID()),
  });
  if (executor.approvals !== undefined) input.bindApprovals?.(executor.approvals);
  const pinnedNames =
    input.tools === undefined ? undefined : new Set(input.tools.map((tool) => tool.name));
  const pinnedDefinitions =
    pinnedNames === undefined
      ? definitions
      : definitions.filter((definition) => pinnedNames.has(definition.name));
  return {
    ...createDispatcher(pinnedDefinitions, {
      executor,
      retainEffect: input.retainEffect,
      trackWave: input.trackWave,
    }),
    executor,
  };
}

export function sessionTool(definition: AnyToolDefinition): SessionGeneration.Tool {
  return SessionGeneration.Tool.parse({
    name: definition.name,
    inputSchema: toolInputSchema(definition),
    category: definition.category,
    ...(definition.sequential ? { sequential: true } : {}),
  });
}

export function toolSpec(definition: AnyToolDefinition): Tool.Spec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: toolInputSchema(definition),
    safe: toolIsSafe(definition.category),
    ...(definition.sequential ? { sequential: true } : {}),
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

function truncate(output: string): string {
  if (output.length <= MODEL_OUTPUT_MAX_CHARS) return output;
  const marker = `\n[truncated: ${output.length} chars]`;
  return `${output.slice(0, MODEL_OUTPUT_MAX_CHARS - marker.length)}${marker}`;
}
