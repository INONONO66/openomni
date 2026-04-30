import type { RunInput } from "@openomni/llm";
import { AgentExecution } from "@openomni/protocol";
import type { Message, Sink, Tool, TraceContext } from "@openomni/protocol";
import { Bus, type Log } from "@openomni/session";
import {
  checkBudget,
  createBudgetState,
  describeBudgetRemaining,
  recordTokenUsage,
  recordTurn,
} from "../budget";
import type { BudgetState } from "../budget";
import { createAssistantMessage, createUserMessage } from "../message-factory";
import { fromConfig, MiddlewareEngine } from "../middleware";
import type { MiddlewareEngineInstance } from "../middleware";
import {
  createBudgetReassuranceMiddleware,
  createBudgetWarningMiddleware,
  createCompactionMiddleware,
  createMemoryMiddleware,
  createToolGuardMiddleware,
} from "../middleware/builtin";
import { buildSystemPrompt } from "../prompt-builder";
import { calculateBackoffMs, classifyRetryReason, shouldRetry, sleep } from "../retry";
import type {
  AgentEvent,
  AgentStep,
  ChatAgentConfig,
  ChatAgentInput,
  HookVerdict,
  TokenUsage,
} from "../types";
import { summarizeInput, toMessagesWithParts } from "./shared";
import { createToolExecutor } from "./tool-executor";

type StreamLog = ReturnType<typeof Log.withContext>;

export interface StreamAgentBase {
  readonly traceId: string;
  readonly sessionId: string;
  readonly runId?: string;
}

export interface StreamRunState {
  budgetState: BudgetState;
  messages: Message.WithParts[];
  lastAssistantText: string;
  readonly steps: AgentStep[];
  readonly totalUsage: TokenUsage;
  continuationCount: number;
  compactionCount: number;
  turnIndex: number;
  readonly startTime: number;
}

export interface TurnArtifacts {
  readonly runInput: RunInput;
  readonly trackingSink: Sink;
  readonly turnUsage: TokenUsage;
  readonly turnToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
  readonly turnToolResults: Array<{
    toolCallId: string;
    result: Tool.Result;
  }>;
  readonly preToolUseVerdicts: HookVerdict[];
}

export type BuildTurnResult =
  | {
      type: "ready";
      budgetReassuranceEvent?: Extract<AgentEvent, { type: "budget_reassurance" }>;
      budgetWarningEvent?: Extract<AgentEvent, { type: "budget_warning" }>;
      turn: TurnArtifacts;
    }
  | { type: "complete"; event: AgentEvent };

export type TurnDecision =
  | {
      kind: "continue";
      messages: Message.WithParts[];
      continuationCount: number;
      compactionCount: number;
      turnIndex: number;
    }
  | { kind: "complete"; event: AgentEvent }
  | { kind: "error"; error: unknown }
  | { kind: "abort"; event: AgentEvent };

export type ErrorDecision =
  | ({ action: "retry"; errorMessage: string } & Extract<TurnDecision, { kind: "error" }>)
  | ({ action: "complete"; errorMessage: string } & Extract<TurnDecision, { kind: "abort" }>)
  | ({ action: "throw"; errorMessage: string } & Extract<TurnDecision, { kind: "error" }>);

export function createStreamRunState(input: ChatAgentInput): StreamRunState {
  return {
    budgetState: createBudgetState(),
    messages: toMessagesWithParts(input.messages, "stream-engine"),
    lastAssistantText: "",
    steps: [],
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    continuationCount: 0,
    compactionCount: 0,
    turnIndex: 0,
    startTime: Date.now(),
  };
}

export function buildMiddlewareEngine(
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): MiddlewareEngineInstance {
  const engine = MiddlewareEngine.create();
  engine.register(createBudgetReassuranceMiddleware());
  engine.register(createBudgetWarningMiddleware());
  for (const reg of fromConfig({ hooks: config.hooks, stepGuard: config.stepGuard })) {
    engine.register(reg);
  }
  if (config.permissions) {
    engine.register(
      createToolGuardMiddleware({
        permission: config.permissions,
        stepGuard: config.stepGuard,
        eventEmitter: config.eventEmitter,
        source: "stream-engine",
        onToolBlocked: (toolCallId, toolName, reason) => {
          Bus.publish(AgentExecution.ToolBlocked, {
            ...agentBase,
            time: Date.now(),
            toolCallId,
            toolName,
            reason,
          });
        },
      }),
    );
  }
  if (config.memory) {
    engine.register(createMemoryMiddleware(config.memory));
  }
  if (config.compaction) {
    engine.register(createCompactionMiddleware(config.compaction));
  }
  for (const reg of config.middleware ?? []) {
    engine.register(reg);
  }
  return engine;
}

export function resolveToolChoice(
  config: ChatAgentConfig,
): "auto" | "required" | "none" | undefined {
  return (config as ChatAgentConfig & { toolChoice?: "auto" | "required" | "none" }).toolChoice;
}

export function assertToolExecutor(config: ChatAgentConfig): void {
  if ((config.tools?.length ?? 0) > 0 && !config.toolExecutor) {
    throw new Error("toolExecutor is required when tools are provided");
  }
}

export async function dispatchPreRun(
  state: StreamRunState,
  engine: MiddlewareEngineInstance,
  config: ChatAgentConfig,
): Promise<AgentEvent | null> {
  const preRunVerdict = await engine.dispatch("pre_run", {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
  });
  if (preRunVerdict.action === "abort") {
    return {
      type: "complete",
      result: {
        text: "",
        steps: [],
        usage: state.totalUsage,
        finishReason: "stop",
        guardAborted: true,
      },
    };
  }
  if (preRunVerdict.action === "inject") {
    state.messages.push(createUserMessage(preRunVerdict.message, "stream-engine"));
  }
  return null;
}

export async function dispatchBudgetCheck(
  state: StreamRunState,
  engine: MiddlewareEngineInstance,
  config: ChatAgentConfig,
  log: StreamLog,
): Promise<AgentEvent | null> {
  const budgetStatus = checkBudget(state.budgetState, config.budget);
  if (budgetStatus !== "exceeded") return null;

  const postRunVerdict = await engine.dispatch("post_run", {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: true,
    continuationCount: state.continuationCount,
    elapsedMs: Date.now() - state.startTime,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
  });
  if (postRunVerdict.action === "transform") {
    const payload = postRunVerdict.input as { text?: unknown };
    if (typeof payload.text === "string") state.lastAssistantText = payload.text;
  }
  log.info("agent.run.completed", {
    finishReason: "max-steps",
    turns: state.budgetState.turns,
    durationMs: Date.now() - state.startTime,
  });
  return {
    type: "complete",
    result: {
      text: state.lastAssistantText,
      steps: state.steps,
      usage: state.totalUsage,
      finishReason: "max-steps",
      compactionCount: getCompactionCount(state),
    },
  };
}

export function emitTurnStart(
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  log: StreamLog,
): void {
  config.eventEmitter?.emit("agent.turn.start", {
    sessionId: "stream-engine",
    time: Date.now(),
    turnIndex: state.budgetState.turns,
  });
  Bus.publish(AgentExecution.TurnStart, {
    ...agentBase,
    time: Date.now(),
    turnIndex: state.budgetState.turns,
  });
  log.debug("agent.turn.started", { turnIndex: state.budgetState.turns });
}

export function emitTurnComplete(
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  log: StreamLog,
  turnUsage: TokenUsage,
): void {
  config.eventEmitter?.emit("agent.turn.complete", {
    sessionId: "stream-engine",
    time: Date.now(),
    turnIndex: state.turnIndex,
    usage: {
      inputTokens: state.totalUsage.inputTokens,
      outputTokens: state.totalUsage.outputTokens,
      totalTokens: state.totalUsage.totalTokens,
    },
  });
  Bus.publish(AgentExecution.TurnComplete, {
    ...agentBase,
    time: Date.now(),
    turnIndex: state.turnIndex,
    usage: {
      inputTokens: state.totalUsage.inputTokens,
      outputTokens: state.totalUsage.outputTokens,
      totalTokens: state.totalUsage.totalTokens,
    },
  });
  log.debug("agent.turn.completed", {
    turnIndex: state.turnIndex,
    inputTokens: turnUsage.inputTokens,
    outputTokens: turnUsage.outputTokens,
  });
}

export async function buildTurn(
  state: StreamRunState,
  config: ChatAgentConfig,
  engine: MiddlewareEngineInstance,
  providerModel: RunInput["model"],
  configuredToolChoice: RunInput["toolChoice"],
  trace: TraceContext.Type,
  agentBase: StreamAgentBase,
  sink?: Sink,
): Promise<BuildTurnResult> {
  const preTurnVerdict = await engine.dispatch("pre_turn", {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: false,
    continuationCount: state.continuationCount,
    elapsedMs: Date.now() - state.startTime,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
  });

  let budgetReassuranceEvent: Extract<AgentEvent, { type: "budget_reassurance" }> | undefined;
  let budgetWarningEvent: Extract<AgentEvent, { type: "budget_warning" }> | undefined;
  if (preTurnVerdict.action === "inject") {
    state.messages.push(createUserMessage(preTurnVerdict.message, "stream-engine"));
    if (preTurnVerdict.message.startsWith("[Budget Status]")) {
      const remaining = describeBudgetRemaining(state.budgetState, config.budget);
      Bus.publish(AgentExecution.BudgetReassurance, {
        ...agentBase,
        time: Date.now(),
        remaining,
        threshold: config.budget?.reassuranceThreshold ?? 0.6,
      });
      budgetReassuranceEvent = { type: "budget_reassurance", remaining };
    } else if (preTurnVerdict.message.startsWith("[Budget Warning]")) {
      const remaining = describeBudgetRemaining(state.budgetState, config.budget);
      Bus.publish(AgentExecution.BudgetWarning, {
        ...agentBase,
        time: Date.now(),
        remaining,
        threshold: config.budget?.warningThreshold ?? 0.8,
      });
      budgetWarningEvent = { type: "budget_warning", remaining };
    }
  } else if (preTurnVerdict.action === "abort") {
    return {
      type: "complete",
      event: {
        type: "complete",
        result: {
          text: state.lastAssistantText,
          steps: state.steps,
          usage: state.totalUsage,
          finishReason: preTurnVerdict.reason === "stalled" ? "stalled" : "stop",
          guardAborted: preTurnVerdict.reason !== "stalled",
          compactionCount: getCompactionCount(state),
        },
      },
    };
  }

  state.budgetState = recordTurn(state.budgetState);
  if (config.signal?.aborted) throw new Error("aborted");

  const preToolUseVerdicts: HookVerdict[] = [];
  const hookedExecutor = config.toolExecutor
    ? createToolExecutor({
        toolExecutor: config.toolExecutor,
        engine,
        getContext: () => ({
          steps: state.steps,
          turnCount: state.budgetState.turns,
          elapsedMs: Date.now() - state.startTime,
          usage: state.totalUsage,
        }),
        onVerdict: (verdict) => preToolUseVerdicts.push(verdict),
        traceContext: trace,
      })
    : undefined;

  const system = await buildTurnSystemPrompt(state, config, engine);
  const turnUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const turnToolCalls: TurnArtifacts["turnToolCalls"] = [];
  const turnToolResults: TurnArtifacts["turnToolResults"] = [];
  const trackingSink = createTrackingSink(
    state,
    sink,
    agentBase,
    turnUsage,
    turnToolCalls,
    turnToolResults,
  );

  return {
    type: "ready",
    budgetReassuranceEvent,
    budgetWarningEvent,
    turn: {
      runInput: {
        messages: state.messages,
        tools: config.tools ?? [],
        system,
        signal: config.signal,
        model: providerModel,
        toolExecutor: hookedExecutor,
        toolChoice: configuredToolChoice,
        maxSteps: config.budget?.maxToolCalls ?? 24,
        providerOptions: config.providerOptions,
      },
      trackingSink,
      turnUsage,
      turnToolCalls,
      turnToolResults,
      preToolUseVerdicts,
    },
  };
}

export function createTrackingSink(
  state: StreamRunState,
  sink: Sink | undefined,
  agentBase: StreamAgentBase,
  turnUsage: TokenUsage,
  turnToolCalls: TurnArtifacts["turnToolCalls"],
  turnToolResults: TurnArtifacts["turnToolResults"],
): Sink {
  let prevInputTokens = 0;
  let prevOutputTokens = 0;

  return {
    onMessage: (message: Message.WithParts) => {
      if (message.info.role === "assistant") {
        const tokens = (message.info as Message.AssistantMessage).tokens;
        const deltaInput = tokens.input - prevInputTokens;
        const deltaOutput = tokens.output - prevOutputTokens;
        prevInputTokens = tokens.input;
        prevOutputTokens = tokens.output;
        if (deltaInput > 0 || deltaOutput > 0) {
          turnUsage.inputTokens += deltaInput;
          turnUsage.outputTokens += deltaOutput;
          turnUsage.totalTokens += deltaInput + deltaOutput;
          state.totalUsage.inputTokens += deltaInput;
          state.totalUsage.outputTokens += deltaOutput;
          state.totalUsage.totalTokens += deltaInput + deltaOutput;
          state.budgetState = recordTokenUsage(state.budgetState, deltaInput, deltaOutput);
        }
      }
      const text = message.parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text) state.lastAssistantText = text;
      sink?.onMessage(message);
    },
    onToolCall: (call) => {
      turnToolCalls.push({
        toolCallId: call.id,
        toolName: call.tool,
        args: call.input,
      });
      Bus.publish(AgentExecution.ToolInvoked, {
        ...agentBase,
        time: Date.now(),
        toolCallId: call.id,
        toolName: call.tool,
        inputSummary: summarizeInput(call.input),
      });
      sink?.onToolCall(call);
    },
    onToolResult: (result) => {
      turnToolResults.push({ toolCallId: result.toolCallId, result });
      sink?.onToolResult(result);
    },
    onSnapshot: sink?.onSnapshot ?? (() => undefined),
  };
}

export async function* handleStop(
  state: StreamRunState,
  config: ChatAgentConfig,
  engine: MiddlewareEngineInstance,
  agentBase: StreamAgentBase,
  log: StreamLog,
  turn: TurnArtifacts,
): AsyncGenerator<AgentEvent, "complete" | "continue"> {
  emitTurnComplete(state, config, agentBase, log, turn.turnUsage);

  if (state.lastAssistantText) yield { type: "text_chunk", text: state.lastAssistantText };
  for (const toolCall of turn.turnToolCalls) {
    yield { type: "tool_call_start", ...toolCall };
  }
  for (const toolResult of turn.turnToolResults) {
    yield { type: "tool_call_complete", ...toolResult };
  }
  for (const verdict of turn.preToolUseVerdicts) {
    yield {
      type: "hook_verdict",
      timing: "pre_tool_use",
      action: verdict.action,
      reason: "reason" in verdict ? verdict.reason : undefined,
    };
  }

  yield { type: "turn_complete", turnIndex: state.turnIndex, usage: turn.turnUsage };

  const step: AgentStep = { type: "text", content: state.lastAssistantText };
  state.steps.push(step);
  if (config.onStepFinish) await config.onStepFinish(step);

  const postTurnVerdict = await engine.dispatch("post_turn", {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: true,
    continuationCount: state.continuationCount,
    elapsedMs: Date.now() - state.startTime,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
  });

  yield {
    type: "hook_verdict",
    timing: "post_turn",
    action: postTurnVerdict.action,
    reason: "reason" in postTurnVerdict ? postTurnVerdict.reason : undefined,
  };

  if (postTurnVerdict.action === "inject") {
    const parentID = state.messages.at(-1)?.info.id ?? "";
    state.messages.push(
      createAssistantMessage(state.lastAssistantText, parentID, "stream-engine"),
      createUserMessage(postTurnVerdict.message, "stream-engine"),
    );
    await applyPostCompaction(state, engine, config, agentBase, true);
    state.continuationCount++;
    state.turnIndex++;
    return flowDecision(continueDecision(state));
  }

  if (postTurnVerdict.action === "abort") {
    const event: AgentEvent = {
      type: "complete",
      result: {
        text: state.lastAssistantText,
        steps: state.steps,
        usage: state.totalUsage,
        finishReason: postTurnVerdict.reason === "stalled" ? "stalled" : "stop",
        guardAborted: postTurnVerdict.reason !== "stalled",
        compactionCount: getCompactionCount(state),
      },
    };
    yield event;
    return flowDecision({ kind: "abort", event });
  }

  await dispatchPostRunTransform(state, engine, config);
  log.info("agent.run.completed", {
    finishReason: "stop",
    turns: state.budgetState.turns,
    durationMs: Date.now() - state.startTime,
  });
  const event: AgentEvent = {
    type: "complete",
    result: {
      text: state.lastAssistantText,
      steps: state.steps,
      usage: state.totalUsage,
      finishReason: "stop",
      compactionCount: getCompactionCount(state),
    },
  };
  yield event;
  return flowDecision({ kind: "complete", event });
}

export async function* handleContinue(
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  log: StreamLog,
  turnUsage: TokenUsage,
): AsyncGenerator<AgentEvent, "continue"> {
  emitTurnComplete(state, config, agentBase, log, turnUsage);
  yield { type: "turn_complete", turnIndex: state.turnIndex, usage: turnUsage };
  state.turnIndex++;
  return continueFlowDecision(continueDecision(state));
}

export async function* handleCompact(
  state: StreamRunState,
  engine: MiddlewareEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): AsyncGenerator<AgentEvent, "continue"> {
  await applyPostCompaction(state, engine, config, agentBase, false);
  state.turnIndex++;
  return continueFlowDecision(continueDecision(state));
}

export async function* handleError(
  state: StreamRunState,
  engine: MiddlewareEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  log: StreamLog,
  error: unknown,
  attempt: number,
  retryPolicy: Parameters<typeof shouldRetry>[0],
): AsyncGenerator<AgentEvent, ErrorDecision> {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const onErrorVerdict = await engine.dispatch("on_error", {
    toolInput: { error: normalizedError },
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: false,
    continuationCount: state.continuationCount,
    elapsedMs: Date.now() - state.startTime,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
  });

  if (onErrorVerdict.action === "abort") {
    const event: AgentEvent = {
      type: "complete",
      result: {
        text: state.lastAssistantText,
        steps: state.steps,
        usage: state.totalUsage,
        finishReason: "stop",
        guardAborted: true,
        compactionCount: getCompactionCount(state),
      },
    };
    yield event;
    return { action: "complete", kind: "abort", event, errorMessage: normalizedError.message };
  }

  const lastError = normalizedError.message;
  const retryReason = classifyRetryReason(lastError);

  if (shouldRetry(retryPolicy, retryReason, attempt)) {
    const backoffMs = calculateBackoffMs(retryPolicy, attempt);
    config.eventEmitter?.emit("agent.error.retry", {
      sessionId: "stream-engine",
      time: Date.now(),
      attempt,
      maxAttempts: retryPolicy.maxAttempts,
      error: lastError,
    });
    Bus.publish(AgentExecution.ErrorRetry, {
      ...agentBase,
      time: Date.now(),
      attempt,
      maxAttempts: retryPolicy.maxAttempts,
      error: lastError,
    });
    log.warn("agent.retry", {
      attempt,
      maxAttempts: retryPolicy.maxAttempts,
      error: lastError,
    });
    yield {
      type: "error",
      error: normalizedError,
      willRetry: true,
    };
    await sleep(backoffMs);
    return { action: "retry", kind: "error", error: normalizedError, errorMessage: lastError };
  }

  log.error("agent.run.failed", { error: lastError });
  yield {
    type: "error",
    error: normalizedError,
    willRetry: false,
  };
  return { action: "throw", kind: "error", error, errorMessage: lastError };
}

function continueDecision(state: StreamRunState): Extract<TurnDecision, { kind: "continue" }> {
  return {
    kind: "continue",
    messages: state.messages,
    continuationCount: state.continuationCount,
    compactionCount: state.compactionCount,
    turnIndex: state.turnIndex,
  };
}

function flowDecision(decision: Exclude<TurnDecision, { kind: "error" }>): "continue" | "complete" {
  return decision.kind === "continue" ? "continue" : "complete";
}

function continueFlowDecision(decision: Extract<TurnDecision, { kind: "continue" }>): "continue" {
  return decision.kind;
}

async function buildTurnSystemPrompt(
  state: StreamRunState,
  config: ChatAgentConfig,
  engine: MiddlewareEngineInstance,
): Promise<string | undefined> {
  let system = buildSystemPrompt(config.systemPrompt, config.tools ?? []);
  const spVerdict = await engine.dispatchSystemPrompt({
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: false,
    continuationCount: state.continuationCount,
    elapsedMs: Date.now() - state.startTime,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
  });
  if (spVerdict.systemPrompt) system = spVerdict.systemPrompt;
  if (spVerdict.prependContext) {
    system = system ? `${spVerdict.prependContext}\n\n${system}` : spVerdict.prependContext;
  }
  if (spVerdict.appendContext) {
    system = system ? `${system}\n\n${spVerdict.appendContext}` : spVerdict.appendContext;
  }
  return system;
}

async function dispatchPostRunTransform(
  state: StreamRunState,
  engine: MiddlewareEngineInstance,
  config: ChatAgentConfig,
): Promise<void> {
  const postRunVerdict = await engine.dispatch("post_run", {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: true,
    continuationCount: state.continuationCount,
    elapsedMs: Date.now() - state.startTime,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
  });
  if (postRunVerdict.action === "transform") {
    const payload = postRunVerdict.input as { text?: unknown };
    if (typeof payload.text === "string") state.lastAssistantText = payload.text;
  }
}

async function applyPostCompaction(
  state: StreamRunState,
  engine: MiddlewareEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  isCompletion: boolean,
): Promise<void> {
  const compactionVerdict = await engine.dispatch("post_compaction", {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion,
    continuationCount: state.continuationCount,
    elapsedMs: Date.now() - state.startTime,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
  });
  if (compactionVerdict.action === "transform") {
    const payload = compactionVerdict.input as Record<string, unknown>;
    if (Array.isArray(payload.messages)) {
      const messagesBefore = state.messages.length;
      state.messages = payload.messages as Message.WithParts[];
      state.compactionCount += 1;
      Bus.publish(AgentExecution.Compaction, {
        ...agentBase,
        time: Date.now(),
        messagesBefore,
        messagesAfter: state.messages.length,
      });
    }
  }
}

function getCompactionCount(state: StreamRunState): number | undefined {
  return state.compactionCount > 0 ? state.compactionCount : undefined;
}
