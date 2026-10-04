import { Clock, Effect, Cause, Exit, Option } from "effect";
import { AgentInvariantViolation, type ExecutionError, ToolBodyFailed, AgentFailure, pretty } from "./failure";
import type { ChatAgentConfig } from "./types";
import type { RunState, TurnArtifacts } from "./turn";
import { recordToolCall } from "./budget";
import { type Tool, type Message, type PlainValue, PlainValueSchema, type ToolDefinition, type ToolExecutionContext, listenForAbort, type AnyToolDefinition, type LedgerSession, type LedgerAction, canonicalDigest, SessionGeneration, type ToolCategory } from "@openomni/protocol";
import { BOUNDED_CONCURRENCY, GenerationOwnership, ToolCatalog, type ProcessServices, SessionLayer } from "./ports";
import { z } from "zod";
import { RawToolSlots, openInvocation, withExecutor, withInvocation, type InvocationFrame, type Executor, activeInvocation, requireExecutor, createExecutor, immutableInput, type DurableExecutor, type ExecutionLedger, type ExecutionBatchResult, type ExecutionRequest, type ExecutionApprovals, type ExecutorOptions } from "./gate/decide";

// ─── from core/execution/tools.ts (#1247) ───
export function buildSystemPrompt(
  basePrompt: string | undefined,
  tools: Tool.Spec[],
): string | undefined {
  const toolPrompts = tools
    .filter((t) => t.prompt)
    .map((t) => `## Tool: ${t.name}\n${t.prompt}`)
    .join("\n\n");

  if (!toolPrompts) return basePrompt;
  if (!basePrompt) return toolPrompts;
  return `${basePrompt}\n\n---\n\n${toolPrompts}`;
}

export function assertToolExecutor(config: ChatAgentConfig): void {
  if ((config.tools?.length ?? 0) > 0 && !config.toolExecutor && !config.toolWave) {
    throw new AgentInvariantViolation("toolExecutor is required when tools are provided");
  }
}

/**
 * Config-time validation: building the metadata map throws on a key
 * collision (see {@link buildToolMetadataMap}). Run alongside
 * `assertToolExecutor` so an ambiguous catalog refuses the run before it is
 * opened, instead of surfacing mid-turn as a retryable "tool" error.
 */
export function assertUnambiguousToolMetadata(config: ChatAgentConfig): void {
  buildToolMetadataMap(config.tools);
}

type ToolPolicyMetadata = Pick<NonNullable<ChatAgentConfig["tools"]>[number], "descriptor"> & {
  readonly labels?: readonly string[];
};

function buildToolMetadataMap(tools: ChatAgentConfig["tools"]): Map<string, ToolPolicyMetadata> {
  const metadata = new Map<string, ToolPolicyMetadata>();
  // Every key names the tool that claimed it. Two tools resolving to the same
  // key (e.g. `a_b` alongside `a.b`, whose underscore-mangled alias is also
  // `a.b`) used to be a silent last-writer-wins — the later tool's labels
  // answered the earlier tool's policy lookups (#606 re-audit). A collision
  // is a configuration error; refuse it loudly, naming both tools.
  // Owners are keyed by tool IDENTITY, not name: two distinct tools carrying
  // the same name (the underscore-mangling seam can manufacture that) must
  // collide too, or the later one silently answers the earlier one's lookups.
  const owners = new Map<string, { readonly name: string; readonly tool: object }>();
  const claim = (key: string, tool: { name: string }, value: ToolPolicyMetadata): void => {
    const owner = owners.get(key);
    if (owner !== undefined && owner.tool !== tool) {
      throw new AgentInvariantViolation(
        `tool metadata collision: "${key}" is claimed by both "${owner.name}" and "${tool.name}"`,
      );
    }
    owners.set(key, { name: tool.name, tool });
    metadata.set(key, value);
  };
  for (const tool of tools ?? []) {
    const labels = tool.labels ?? tool.descriptor?.labels;
    if (labels === undefined && tool.descriptor === undefined) continue;
    const value = {
      ...(labels !== undefined && { labels }),
      ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
    };
    claim(tool.name, tool, value);
    const canonical = labels?.find((label) => label.startsWith("tool:"))?.slice(5);
    if (canonical) claim(canonical, tool, value);
    const dotted = tool.name.replace(/_/g, ".");
    if (dotted !== tool.name) claim(dotted, tool, value);
  }
  return metadata;
}

interface PreparedTurnTools {
  readonly allTools: Tool.Spec[];
  readonly executor: NonNullable<ChatAgentConfig["toolExecutor"]> | undefined;
}

export function prepareTurnTools(state: RunState, config: ChatAgentConfig): PreparedTurnTools {
  const allTools = config.tools ?? [];
  const configuredExecutor = config.toolExecutor;
  const executor = configuredExecutor
    ? (call: Tool.Call, context?: Tool.ExecutionContext) =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((startedAt) =>
          configuredExecutor(call, context).pipe(Effect.ensuring(
            Clock.currentTimeMillis.pipe(Effect.flatMap((endedAt) => Effect.sync(() => {
              state.budgetState = recordToolCall(state.budgetState, endedAt - startedAt);
            }))),
          )),
        ))
    : undefined;
  return { allTools, executor };
}

// ─── from core/execution/tool-wave.ts (#1247) ───
export interface WaveControl {
  readonly signal: AbortSignal;
  readonly retain?: (effect: Promise<void>) => void;
}


/** Assemble tool results on the original assistant slots, never completion order. */
export function settleModelTools(
  turn: TurnArtifacts,
  config: ChatAgentConfig,
  state: RunState,
): Effect.Effect<number, ExecutionError> {
  return Effect.gen(function* () {
  const assistant = turn.turnAssistant.message;
  const pending =
    assistant?.parts.filter(
      (part: Message.Part): part is Message.ToolPart =>
        part.type === "tool" &&
        (part.state.status === "pending" || part.state.status === "running"),
    ) ?? [];
  if (assistant === undefined || pending.length === 0) return 0;
  const calls = pending.map((part) => ({
    id: part.callID,
    tool: part.tool,
    input: part.state.input,
  }));
  const execute = turn.toolExecutor;
  const startedAt = yield* Clock.currentTimeMillis;
  if (config.toolWave === undefined && execute === undefined)
    return yield* Effect.die(new Error("tool wave executor is required"));
  const executed =
    config.toolWave !== undefined
      ? yield* config.toolWave(calls, config.signal)
      : yield* Effect.forEach(calls, (call) => {
          if (execute === undefined) return Effect.die(new Error("tool executor missing"));
          return Effect.exit(Effect.suspend(() => execute(call, { signal: config.signal }))).pipe(
            Effect.flatMap((exit) => {
              if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
              if (Cause.hasInterrupts(exit.cause)) return Effect.failCause(exit.cause);
              const output = Option.match(Cause.findErrorOption(exit.cause), {
                onNone: () => pretty(exit.cause),
                onSome: (error) => error.message,
              });
              return Effect.succeed({ id: call.id, toolCallId: call.id, toolName: call.tool, output, isError: true });
            }),
          );
        }, { concurrency: BOUNDED_CONCURRENCY });
  const results = calls.map((call) => {
    const result = executed.find((result) => result.toolCallId === call.id);
    if (result === undefined) throw new AgentInvariantViolation(`missing tool result: ${call.id}`);
    return result;
  });
  const byId = new Map(results.map((result) => [result.toolCallId, result]));
  const settledAt = yield* Clock.currentTimeMillis;
  // The out-of-process wave bills its real wall time once; the in-process
  // executor path already billed per call inside prepareTurnTools.
  if (config.toolWave !== undefined) {
    const elapsedMs = settledAt - startedAt;
    for (let index = 0; index < calls.length; index += 1) {
      state.budgetState = recordToolCall(state.budgetState, index === 0 ? elapsedMs : 0);
    }
  }
  const parts = assistant.parts.map((part): Message.Part => {
    if (part.type !== "tool" || !pending.includes(part)) return part;
    const result = byId.get(part.callID);
    if (result === undefined) throw new AgentInvariantViolation(`missing tool result: ${part.callID}`);
    return {
      ...part,
      state: result.isError
        ? {
            status: "error",
            input: part.state.input,
            error: result.output,
            time: { start: startedAt, end: settledAt },
          }
        : {
            status: "completed",
            input: part.state.input,
            output: result.output,
            title: part.tool,
            metadata: {},
            time: { start: startedAt, end: settledAt },
          },
    };
  });
  turn.turnAssistant.message = { ...assistant, parts };
  for (const result of results) turn.trackingSink.onToolResult(result);
  turn.trackingSink.onMessage(turn.turnAssistant.message);
  // Exhaustion is judged (and its telemetry published) once, in handleStop's
  // stop judgment — an early fail here would terminate the run without the
  // guaranteed "budget exceeded" operational record.
  return calls.length;
  });
}

// ─── from tool-body.ts (#1247) ───
export const ToolBodyOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("timed_out") }).strict(),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    errorKind: z.enum(["invalid_input", "precondition_failed", "execution_failed", "invalid_output"]),
  }).strict(),
  z.object({ status: z.literal("success"), output: PlainValueSchema }).strict(),
]);
type ToolBodyOutcome = z.infer<typeof ToolBodyOutcome>;

/** The only async-tool boundary. Register ownership and handlers before entering foreign code. */
export function executeToolBody<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  input: z.output<In>,
  context: ToolExecutionContext,
  timeoutMs: number | undefined,
  executor?: Executor,
  invocation?: InvocationFrame,
): Effect.Effect<ToolBodyOutcome, ToolBodyFailed, RawToolSlots> {
  return Effect.gen(function* () {
    const slots = yield* RawToolSlots;
    const execution = Effect.callback<ToolBodyOutcome, ToolBodyFailed>((resume) => {
      const release = slots.open();
      const controller = new AbortController();
      const scopedContext = {
        ...context,
        signal: AbortSignal.any([context.signal, controller.signal]),
      };
      const owned = invocation === undefined ? undefined : openInvocation(invocation, definition.name);
      const detach = listenForAbort(scopedContext.signal, () => owned?.close("interrupted"));
      const settle = (reason: "settled" | "failed") => {
        owned?.close(reason);
        detach();
        release();
      };
      const activeExecutor = owned?.frame.executor ?? executor;
      const enter = () => activeExecutor === undefined ? definition.execute(input, scopedContext)
        : withExecutor(activeExecutor, () => definition.execute(input, scopedContext));
      const raw = Promise.resolve().then(() => owned === undefined ? enter() : withInvocation(owned.frame, enter));
      raw.then(
        (value) => {
          settle("settled");
          resume(Effect.sync(() => decodeOutput(definition, value)));
        },
        (cause: CaughtValue) => {
          settle("failed");
          // An explicit ToolRefused keeps its model-facing classification; every other
          // foreign rejection is a typed body failure the executor records as evidence.
          resume(isToolRefusal(cause)
            ? Effect.succeed<ToolBodyOutcome>({ status: "error", message: cause.message, errorKind: "precondition_failed" })
            : Effect.fail(new ToolBodyFailed({ tool: definition.name, cause: String(cause) })));
        },
      );
      return Effect.sync(() => controller.abort());
    });
    if (timeoutMs === undefined) return yield* execution;
    return yield* execution.pipe(Effect.timeoutOption(timeoutMs), Effect.map((outcome: Option.Option<ToolBodyOutcome>) =>
      Option.getOrElse(outcome, (): ToolBodyOutcome => ({ status: "timed_out" }))));
  });
}

function decodeOutput<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  value: z.output<Out>,
): ToolBodyOutcome {
  const parsed = definition.output.safeParse(value);
  const json = parsed.success ? PlainValueSchema.safeParse(parsed.data) : parsed;
  if (!json.success) {
    return {
      status: "error",
      message: `${definition.name} produced invalid output`,
      errorKind: "invalid_output",
    };
  }
  return { status: "success", output: json.data };
}

type CaughtValue = PlainValue | Error | bigint | symbol | undefined | ((...args: never[]) => void);

function isToolRefusal(value: CaughtValue): value is Error {
  return value instanceof Error && value.name === "ToolRefused";
}

// ─── from tool-dispatcher.ts (#1247) ───
const NEVER_ABORTED = new AbortController().signal;

const MODEL_OUTPUT_MAX_CHARS = 32_000;
/** Executable catalog data copied into each captured generation's dispatch table. */
export type ToolDispatchDefinition<In extends z.ZodType = z.ZodType, Out extends z.ZodType = z.ZodType> = ToolDefinition<In, Out> & {
  readonly approval?: (input: PlainValue) => NonNullable<ExecutionRequest["approval"]>;
};

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

export interface Dispatcher {
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
): ToolDispatchDefinition<In, Out> {
  if (definition.name.trim() === "") throw new AgentInvariantViolation("tool name must not be empty");
  if (definition.description.trim() === "") throw new AgentInvariantViolation("tool description must not be empty");
  if (toolInputSchema(definition).type !== "object") {
    throw new AgentInvariantViolation(`${definition.name} input schema root must be an object`);
  }
  return {
    ...definition,
    ...(approval === undefined ? {} : {
      approval: (input: PlainValue) => approval(definition.input.parse(input)),
    }),
  };
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
    throw new AgentInvariantViolation(`${definition.name} input schema root must be an object`);
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
  options?: DispatcherOptions,
): Effect.Effect<Dispatcher, ExecutionError, ToolCatalog> {
  return Effect.gen(function* () {
  const { definitions } = yield* ToolCatalog;
  return buildDispatcher(definitions, options);
  });
}

function buildDispatcher(definitions: readonly ToolDispatchDefinition[], options?: DispatcherOptions, invocation?: () => InvocationFrame): Dispatcher {
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
    options?.executor ?? activeInvocation.getStore()?.executor;
  const toolsGeneration = new Map(definitions.map((definition) => [
    definition.name,
    Object.freeze({ definition, approval: definition.approval }),
  ]));
  type Prepared =
    | { readonly kind: "refused"; readonly result: ToolDispatchResult }
    | {
        readonly kind: "ready";
        readonly executor: Executor;
         readonly request: ExecutionRequest;
        readonly body: (receipt: LedgerAction.Receipt, admittedInput: PlainValue) => Effect.Effect<PlainValue, ExecutionError, RawToolSlots>;
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
    const entry = toolsGeneration.get(call.tool);
    if (entry === undefined) {
      return {
        kind: "refused",
        result: failed(call, `unregistered tool: ${call.tool}`, "unregistered_tool"),
      };
    }
    const { definition, approval: binding } = entry;
    const parsedInput = definition.input.safeParse(call.input);
    if (!parsedInput.success) {
      const reason = invalidInputReason(parsedInput.error);
      return {
        kind: "refused",
        result: failed(call, `${definition.name} refused: ${reason}`, "invalid_input"),
      };
    }

    const executor = requireExecutor(resolveExecutor());
    const parsedValue = PlainValueSchema.parse(parsedInput.data);
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
    let admittedValue = parsedValue;
    const body = (_receipt: LedgerAction.Receipt, admittedInput: PlainValue) => Effect.suspend(() => {
      const admitted = definition.input.safeParse(admittedInput);
      if (!admitted.success) return Effect.succeed({ status: "error" as const, errorKind: "invalid_input" as const, message: invalidInputReason(admitted.error) });
      admittedValue = immutableInput(PlainValueSchema.parse(admitted.data));
      return executeToolBody(
      definition,
      admittedValue,
      {
        ...context,
        ...(approval === undefined ? {} : { domainRevisions: approval.domainRevisions }),
      },
      options?.timeoutMs,
      executor,
      invocation?.(),
      ).pipe(Effect.map(PlainValueSchema.parse));
    });
    const finish = (
      execution: ExecutionBatchResult,
    ): ToolDispatchResult | CellToolDispatchResult =>
      finishResult(call, definition, admittedValue, door, execution);
    let modelResult: ToolDispatchResult | undefined;
    return {
      kind: "ready",
      executor,
      request: {
        ...request,
        ...(door === "model"
          ? {
              toolResult: (execution: ExecutionBatchResult): Tool.Result => {
                const result = finish(execution);
                if (typeof result.output !== "string")
                  throw new AgentInvariantViolation("model tool output must be rendered text");
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
    return Effect.suspend(() => {
      const prepared = prepare(call, context, door);
      if (prepared.kind === "refused") return Effect.succeed(prepared.result);
      const runBatch = requireExecutor(prepared.executor.runBatch);
      return runBatch([prepared], { signal: context.signal ?? NEVER_ABORTED }).pipe(
        Effect.flatMap((results) => {
          const result = results[0];
          if (result === undefined) return Effect.die(new Error("single dispatch lost its result"));
          if (door === "cell" && result.terminal === "interrupted") return Effect.interrupt;
          return Effect.succeed(prepared.finish(result));
        }),
      );
    });
  }

  function runPreparedBatch(
    ready: readonly Extract<Prepared, { kind: "ready" }>[],
    context: DispatchContext,
    retain?: (effect: Promise<void>) => void,
  ) {
    const runBatch = requireExecutor(resolveExecutor()?.runBatch);
    return runBatch(ready, {
      signal: context.signal ?? NEVER_ABORTED,
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
        if (result === undefined) throw new AgentInvariantViolation("wave result missing");
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
          return yield* Effect.die(new Error("captured invocation no longer parses"));
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
  readonly ledger: ExecutionLedger;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly trackWave?: (wave: Promise<void>) => void;
  readonly bindApprovals?: (approvals: ExecutionApprovals) => void;
}

function guardedOperations(ledger: ExecutionLedger, turnId: string): LedgerAction.Node[] {
  const actions: LedgerAction.Node[] = [];
  let cursor = 0;
  for (;;) {
    const page = ledger.guardedOperationsPage?.(turnId, cursor) ?? [];
    actions.push(...page);
    if (page.length < 256) return actions;
    cursor = page.at(-1)?.ordinal ?? cursor;
  }
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
    const parsed = PlainValueSchema.parse(intent.originalArgs ?? intent.value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new AgentInvariantViolation(`invalid durable invocation: ${action.id}`);
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
  readonly authorizeApproval?: ExecutorOptions["authorizeApproval"];
}

/**
 * Compose the per-turn executor and dispatcher for a prepared runner turn. Both
 * the resident and worker runners build this identically; keeping it here makes
 * "how a turn's tools commit durably" a single owner.
 */
export function createTurnDispatcher(
  input: TurnDispatchInput,
  runtime: TurnDispatchRuntime,
): Effect.Effect<Dispatcher & { readonly executor: DurableExecutor }, ExecutionError, ProcessServices | SessionLayer | ToolCatalog | GenerationOwnership> {
  return Effect.gen(function* () {
  const { definitions } = yield* ToolCatalog;
  const generation = yield* GenerationOwnership;
  const { policy } = yield* SessionLayer;
  for (const captured of input.tools ?? []) {
    const definition = definitions.find((candidate) => candidate.name === captured.name);
    if (
      definition === undefined ||
      canonicalDigest(sessionTool(definition)) !== canonicalDigest(captured)
    ) {
      return yield* new AgentFailure({ operation: "dispatcher.acquire", cause: `captured catalog mismatch: ${captured.name}` });
    }
  }
  const executor = yield* createExecutor({
    retryAlarm: runtime.retryAlarm,
    closeGraceMs: runtime.closeGraceMs,
    signal: input.signal,
    retainEffect: input.retainEffect,
    authorizeApproval: runtime.authorizeApproval,
    approvalTimeoutMs: runtime.approvalTimeoutMs,
    ledger: input.ledger,
    identity: {
      sessionId: input.sessionId,
      role: input.role,
      parentActionId: input.turnId ?? input.actionId,
      turnId: input.turnId,
      toolsGeneration: input.toolsGeneration,
      toolsHash: input.toolsHash,
      systemHash: input.systemHash,
    },
  });
  if (executor.approvals !== undefined) input.bindApprovals?.(executor.approvals);
  const pinnedNames =
    input.tools === undefined ? undefined : new Set(input.tools.map((tool) => tool.name));
  const pinnedDefinitions =
    pinnedNames === undefined
      ? definitions
      : definitions.filter((definition) => pinnedNames.has(definition.name));
  const dispatcher = buildDispatcher(pinnedDefinitions, {
    executor,
    retainEffect: input.retainEffect,
    trackWave: input.trackWave,
  }, () => frame);
  const frame: InvocationFrame = { executor, cell: dispatcher, policy, generation };
  return {
    ...dispatcher,
    executor: {
      ...executor,
      recover() {
        // Persisted evidence settles ordinary crash-open intents first; only
        // request-bearing waves then re-admit their captured invocations.
        return executor.recover().pipe(Effect.andThen(() =>
          dispatcher.recover(guardedOperations(input.ledger, input.turnId ?? input.actionId), {
            sessionId: input.sessionId,
            turnId: input.turnId ?? input.actionId,
            signal: input.signal,
          }),
        ));
      },
    },
  };
  });
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
    signal: context.signal ?? NEVER_ABORTED,
  };
}

function renderedResult(result: ToolDispatchResult | CellToolDispatchResult): ToolDispatchResult {
  if (typeof result.output !== "string") throw new AgentInvariantViolation("model tool output must be rendered text");
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

export { currentExecutor } from "./gate/decide";
