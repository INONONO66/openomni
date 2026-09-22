import { executeToolBody, ToolBodyOutcome } from "./tool-body";
import { activeExecutor, ExecutorContextError } from "./executor-context";
export { currentExecutor } from "./executor-context";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import {
  type AnyToolDefinition,
  type BusEvent,
  type LedgerSession,
  type LedgerAction,
  type ObservationSink,
  type PlainValue,
  PlainValueSchema,
  canonicalDigest,
  SessionGeneration,
  type Tool,
  type ToolCategory,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@openomni/protocol";
import { z } from "zod";
import { entropyOf } from "./core/entropy";
import { Effect } from "effect";
import type { ExecutionError } from "./errors";
import type { RawToolSlots } from "./executor-raw";
import {
  createExecutor,
  type DurableExecutor,
  type ExecutionLedger,
  type Executor,
  type ExecutionBatchResult,
  type ExecutionRequest,
  type ExecutionApprovals,
  type ExecutorOptions,
} from "./executor";

const MODEL_OUTPUT_MAX_CHARS = 32_000;
const approvalBindings = new WeakMap<
  AnyToolDefinition,
  (input: PlainValue) => NonNullable<ExecutionRequest["approval"]>
>();

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

interface DispatcherOptions {
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

interface Dispatcher {
  readonly executor?: Executor;
  readonly specs: readonly Tool.Spec[];
  execute(call: Tool.Call, context: DispatchContext): Effect.Effect<ToolDispatchResult, ExecutionError>;
  executeWave(
    calls: readonly Tool.Call[],
    context: DispatchContext,
  ): Effect.Effect<readonly ToolDispatchResult[], ExecutionError>;
  executeCell(call: Tool.Call, context: DispatchContext): Effect.Effect<CellToolDispatchResult, ExecutionError>;
  recover(actions: readonly LedgerAction.Node[], context: DispatchContext): Effect.Effect<void, ExecutionError>;
}

export function defineTool<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  approval?: (input: z.output<In>) => NonNullable<ExecutionRequest["approval"]>,
): ToolDefinition<In, Out> {
  if (definition.name.trim() === "") throw new Error("tool name must not be empty");
  if (definition.description.trim() === "") throw new Error("tool description must not be empty");
  if (toolInputSchema(definition).type !== "object") {
    throw new Error(`${definition.name} input schema root must be an object`);
  }
  if (approval !== undefined)
    approvalBindings.set(definition, (input) => approval(definition.input.parse(input)));
  return definition;
}

export function eraseTool<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
): AnyToolDefinition {
  return definition;
}

type JsonSchemaObject = Record<string, PlainValue>;

export function toolInputSchema(definition: AnyToolDefinition): JsonSchemaObject {
  const { $schema: _dialect, ...projected } = z
    .record(z.string(), PlainValueSchema)
    .parse(z.toJSONSchema(definition.input, { io: "input", target: "draft-7" }));
  if (projected.type !== "object") {
    throw new Error(`${definition.name} input schema root must be an object`);
  }
  return projected;
}

function invalidInputReason(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  return issue === undefined
    ? "invalid input"
    : path === ""
      ? issue.message
      : `${path}: ${issue.message}`;
}

/** Non-executed terminals map to a failed result; a cell-door refusal throws. */
function finishResult(
  call: Tool.Call,
  definition: AnyToolDefinition,
  inputData: PlainValue,
  door: "model" | "cell",
  execution: ExecutionBatchResult,
): ToolDispatchResult | CellToolDispatchResult {
  if (execution.terminal === "interrupted" || execution.terminal === "outcome_unknown")
    return failed(call, execution.reason, "execution_failed");
  if (execution.terminal === "executed" && execution.failure !== undefined)
    return failed(
      call,
      execution.failure._tag === "ToolBodyFailed" ? execution.failure.cause : execution.failure.message,
      "execution_failed",
    );
  if (execution.terminal !== "executed") {
    const refusal = new ToolRefused(definition.name, execution.reason);
    if (door === "cell") throw refusal;
    return failed(call, refusal.message, "precondition_failed");
  }
  const parsedOutcome = ToolBodyOutcome.safeParse(execution.value);
  if (!parsedOutcome.success) {
    return failed(call, `${definition.name} produced invalid output`, "invalid_output");
  }
  const outcome = parsedOutcome.data;
  if (outcome.status === "timed_out") {
    return failed(call, `${definition.name} timed out`, "execution_failed");
  }
  if (outcome.status === "error") {
    return failed(call, outcome.message, outcome.errorKind);
  }

  const transformedOutput = definition.output.safeParse(outcome.output);
  if (!transformedOutput.success) {
    return failed(call, `${definition.name} produced invalid output`, "invalid_output");
  }
  const output = PlainValueSchema.safeParse(transformedOutput.data);
  if (!output.success) {
    return failed(call, `${definition.name} produced invalid output`, "invalid_output");
  }
  return {
    toolCallId: call.id,
    id: call.id,
    toolName: call.tool,
    output:
      door === "cell" ? output.data : truncate(definition.render(inputData, output.data)),
  } satisfies ToolDispatchResult | CellToolDispatchResult;
}

function approvalFromOriginal(
  original: PlainValue | undefined,
  approval: ExecutionRequest["approval"],
): ExecutionRequest["approval"] {
  if (
    original === undefined ||
    original === null ||
    typeof original !== "object" ||
    Array.isArray(original)
  )
    return approval;
  return {
    required: original.approvalRequired === true,
    domainRevisions: z.record(z.string(), z.number().int()).parse(original.domainRevisions),
    timeoutMs: approval?.timeoutMs,
  };
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
        readonly body: () => Effect.Effect<PlainValue, ExecutionError, RawToolSlots>;
        readonly sequential?: true;
        readonly finish: (
          result: ExecutionBatchResult,
        ) => ToolDispatchResult | CellToolDispatchResult;
      };
  function prepare(
    call: Tool.Call,
    providedContext: DispatchContext,
    door: "model" | "cell",
    originalAction?: LedgerAction.Node,
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
      const reason = invalidInputReason(parsedInput.error);
      return {
        kind: "refused",
        result: failed(call, `${definition.name} refused: ${reason}`, "invalid_input"),
      };
    }

    const executor = resolveExecutor();
    if (executor === undefined) {
      throw new ExecutorContextError();
    }
    const parsedValue = PlainValueSchema.parse(parsedInput.data);
    const binding = approvalBindings.get(definition);
    const approval = approvalFromOriginal(originalAction?.intent.value, binding?.(parsedValue));
    const request: ExecutionRequest = {
      kind: "tool",
      op: definition.name,
      intent: parsedValue,
      effect: { category: definition.category },
      toolObservation: {
        turnId: context.turnId,
        callId: call.id,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
      ...(originalAction === undefined ? {} : { originalAction }),
      ...(approval === undefined
        ? {}
        : {
            approval,
            domainRevisions: () => binding?.(parsedValue).domainRevisions ?? {},
          }),
    };
    const body = () => executeToolBody(
      definition,
      parsedInput.data,
      {
        ...context,
        ...(approval === undefined ? {} : { domainRevisions: approval.domainRevisions }),
      },
      options?.timeoutMs,
      executor,
    ).pipe(Effect.map(PlainValueSchema.parse));
    const finish = (
      execution: ExecutionBatchResult,
    ): ToolDispatchResult | CellToolDispatchResult =>
      finishResult(call, definition, parsedValue, door, execution);
    let modelResult: ToolDispatchResult | undefined;
    return {
      kind: "ready",
      request: {
        ...request,
        ...(door === "model"
          ? {
              toolResult: (execution: ExecutionBatchResult): Tool.Result => {
                const result = finish(execution);
                if (typeof result.output !== "string")
                  throw new Error("model tool output must be rendered text");
                modelResult = { ...result, output: result.output };
                return modelResult;
              },
            }
          : {}),
      },
      body,
      finish: (execution) => modelResult ?? finish(execution),
      ...(definition.sequential ? { sequential: true } : {}),
    };
  }

  function dispatch(call: Tool.Call, context: DispatchContext, door: "model" | "cell") {
    return Effect.gen(function* () {
      const prepared = prepare(call, context, door);
      if (prepared.kind === "refused") return prepared.result;
      const executor = resolveExecutor();
      if (executor === undefined) throw new ExecutorContextError();
      if (executor.runBatch === undefined) throw new ExecutorContextError();
      const results = yield* executor.runBatch([prepared], { signal: context.signal ?? new AbortController().signal });
      const result = results[0];
      if (result === undefined) throw new Error("single dispatch lost its result");
      if (door === "cell" && result.terminal === "interrupted")
        return yield* Effect.interrupt;
      return prepared.finish(result);
    });
  }

  function runPreparedBatch(
    ready: readonly Extract<Prepared, { kind: "ready" }>[],
    context: DispatchContext,
    retain?: (effect: Promise<void>) => void,
  ) {
    const executor = resolveExecutor();
    if (executor?.runBatch === undefined) throw new ExecutorContextError();
    return executor.runBatch(ready, {
      signal: context.signal ?? new AbortController().signal,
      ...(retain === undefined ? {} : { retain }),
    });
  }

  function executeWave(
    calls: readonly Tool.Call[],
    context: DispatchContext,
  ): Effect.Effect<readonly ToolDispatchResult[], ExecutionError> {
    return Effect.gen(function* () {
      const prepared = calls.map((call) => prepare(call, context, "model"));
      const ready = prepared.filter(
        (item: Prepared): item is Extract<Prepared, { kind: "ready" }> => item.kind === "ready",
      );
      const results = yield* runPreparedBatch(ready, context, options?.retainEffect);
      let index = 0;
      return prepared.map((item) => {
        if (item.kind === "refused") return item.result;
        const result = results[index++];
        if (result === undefined) throw new Error("wave result missing");
        return renderedResult(item.finish(result));
      });
    });
  }

  return {
    ...(options?.executor === undefined ? {} : { executor: options.executor }),
    specs: definitions.filter((definition) => definition.visibility.model.length > 0).map(toolSpec),
    executeWave,
    recover(actions, context) {
      return Effect.gen(function* () {
      const groups = recoverableWaves(actions, context.turnId);
      const approvalWaves = new Set<string>();
      for (const action of actions) {
        const intent = action.intent.value;
        if (
          intent !== null &&
          typeof intent === "object" &&
          !Array.isArray(intent) &&
          typeof intent.waveId === "string" &&
          intent.approvalRequired === true
        ) {
          approvalWaves.add(intent.waveId);
        }
      }
      for (const [waveId, group] of groups) {
        if (!approvalWaves.has(waveId)) continue;
        const prepared = group.map(({ action, call }) => prepare(call, context, "model", action));
        if (prepared.some((item) => item.kind === "refused"))
          throw new Error("captured invocation no longer parses");
        const ready = prepared.filter(
          (item: Prepared): item is Extract<Prepared, { kind: "ready" }> => item.kind === "ready",
        );
        const results = yield* runPreparedBatch(ready, context);
        results.forEach((result, index) => {
          ready[index]?.finish(result);
        });
      }
      });
    },
    execute(call, context) {
      return dispatch(call, context, "model").pipe(Effect.map(renderedResult));
    },
    executeCell(call, context) {
      return dispatch(call, context, "cell");
    },
  };
}

/**
 * The per-turn identity and lease under which a dispatcher's tools commit.
 * Mirrors the fields both the resident and worker runners already pin on their
 * {@link SessionRunnerInput}, so composing the executor+dispatcher has one owner
 * instead of being copied per role.
 */
interface TurnDispatchInput {
  readonly signal?: AbortSignal;
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly actionId: string;
  readonly turnId?: string;
  readonly tools?: readonly SessionGeneration.Tool[];
  readonly toolsGeneration?: number;
  readonly toolsHash?: string;
  readonly systemHash?: string;
  readonly policy: CompiledPolicySnapshot;
  readonly ledger: ExecutionLedger;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly trackWave?: (wave: Promise<void>) => void;
  readonly bindApprovals?: (approvals: ExecutionApprovals) => void;
}

function recoverableWaves(actions: readonly LedgerAction.Node[], turnId: string | undefined) {
  const groups = new Map<string, { action: LedgerAction.Node; call: Tool.Call }[]>();
  const settledIntents = new Set(
    actions
      .filter((action) => {
        const effect = action.effect.value;
        return (
          action.kind === "tool" &&
          effect !== null &&
          typeof effect === "object" &&
          !Array.isArray(effect) &&
          effect.phase === "result"
        );
      })
      .map((action) => action.parentId),
  );
  for (const action of actions) {
    if (action.kind !== "tool") continue;
    const intent = action.intent.value;
    if (
      intent === null ||
      typeof intent !== "object" ||
      Array.isArray(intent) ||
      intent.phase !== "intent" ||
      intent.turnId !== turnId ||
      typeof intent.callId !== "string" ||
      typeof intent.op !== "string" ||
      typeof intent.waveId !== "string"
    )
      continue;
    if (settledIntents.has(action.id)) continue;
    const parsed = PlainValueSchema.parse(intent.value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`invalid durable invocation: ${action.id}`);
    const group = groups.get(intent.waveId) ?? [];
    group.push({ action, call: { id: intent.callId, tool: intent.op, input: parsed } });
    groups.set(intent.waveId, group);
  }
  return groups;
}

/** The runtime clock/entropy/observation sink shared across a session's turns. */
interface TurnDispatchRuntime {
  readonly closeGraceMs?: ExecutorOptions["closeGraceMs"];
  readonly retryAlarm?: ExecutorOptions["retryAlarm"];
  readonly approvalTimeoutMs?: ExecutorOptions["approvalTimeoutMs"];
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
): Dispatcher & { readonly executor: DurableExecutor } {
  for (const captured of input.tools ?? []) {
    const definition = definitions.find((candidate) => candidate.name === captured.name);
    if (
      definition === undefined ||
      canonicalDigest(sessionTool(definition)) !== canonicalDigest(captured)
    ) {
      throw new Error(`captured catalog mismatch: ${captured.name}`);
    }
  }
  const executor = createExecutor({
    retryAlarm: runtime.retryAlarm,
    closeGraceMs: runtime.closeGraceMs,
    signal: input.signal,
    retainEffect: input.retainEffect,
    policy: input.policy,
    authorizeApproval: runtime.authorizeApproval,
    approvalTimeoutMs: runtime.approvalTimeoutMs,
    ledger: input.ledger,
    observations: runtime.observations,
    identity: {
      sessionId: input.sessionId,
      role: input.role,
      parentActionId: input.turnId ?? input.actionId,
      turnId: input.turnId,
      toolsGeneration: input.toolsGeneration,
      toolsHash: input.toolsHash,
      systemHash: input.systemHash,
    },
    clock: runtime.clock ?? Date.now,
    entropy: entropyOf(runtime),
  });
  if (executor.approvals !== undefined) input.bindApprovals?.(executor.approvals);
  const pinnedNames =
    input.tools === undefined ? undefined : new Set(input.tools.map((tool) => tool.name));
  const pinnedDefinitions =
    pinnedNames === undefined
      ? definitions
      : definitions.filter((definition) => pinnedNames.has(definition.name));
  const dispatcher = createDispatcher(pinnedDefinitions, {
    executor,
    retainEffect: input.retainEffect,
    trackWave: input.trackWave,
  });
  return {
    ...dispatcher,
    executor: {
      ...executor,
      recover() {
        // Persisted evidence settles ordinary crash-open intents first; only
        // request-bearing waves then re-admit their captured invocations.
        return executor.recover().pipe(Effect.andThen(() =>
          dispatcher.recover(input.ledger.actions?.() ?? [], {
            sessionId: input.sessionId,
            turnId: input.turnId ?? input.actionId,
            signal: input.signal,
          }),
        ));
      },
    },
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

function renderedResult(result: ToolDispatchResult | CellToolDispatchResult): ToolDispatchResult {
  if (typeof result.output !== "string") throw new Error("model tool output must be rendered text");
  return { ...result, output: result.output };
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
  const originalBytes = Buffer.byteLength(output, "utf8");
  // Reserve the marker's final width and never split a supplementary code point.
  let kept = MODEL_OUTPUT_MAX_CHARS;
  for (;;) {
    if ((output.codePointAt(kept - 1) ?? 0) > 0xffff) kept -= 1;
    const prefix = output.slice(0, kept);
    const droppedBytes = originalBytes - Buffer.byteLength(prefix, "utf8");
    const marker = `\n[truncated: ${droppedBytes} bytes dropped; ${originalBytes} bytes original]`;
    const available = MODEL_OUTPUT_MAX_CHARS - marker.length;
    if (kept <= available) return `${prefix}${marker}`;
    kept = available;
  }
}
