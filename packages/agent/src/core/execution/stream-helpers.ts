import type { RunInput } from "@openomni/llm";
import { AgentExecution, Operational } from "@openomni/protocol";
import type { Message, Policy, Sink, Tool, TraceContext } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import {
  checkBudget,
  createBudgetState,
  describeBudgetRemaining,
  recordToolCall,
  recordTokenUsage,
  recordTurn,
} from "../budget";
import type { BudgetState } from "../budget";
import { createAssistantMessage, createUserMessage } from "../message-factory";
import { PolicyEngine } from "../policy";
import type { PolicyEngineInstance } from "../policy";
import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
  createCompactionPolicy,
  createMemoryPolicy,
  createToolPermissionPolicy,
} from "../policy/builtin";
import { buildSystemPrompt } from "../prompt-builder";
import * as Retry from "../retry";
import type { AgentEvent, AgentStep, ChatAgentConfig, ChatAgentInput, TokenUsage } from "../types";
import { toMessagesWithParts } from "./shared";
import { createToolExecutor } from "./tool-executor";

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
  readonly preToolUseVerdicts: Policy.Verdict[];
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

export function buildPolicyEngine(
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): PolicyEngineInstance {
  const engine = PolicyEngine.create({
    traceContext: {
      traceId: agentBase.traceId,
      ...(agentBase.sessionId !== "" && { sessionId: agentBase.sessionId }),
      ...(agentBase.runId !== undefined && { runId: agentBase.runId }),
    },
  });
  engine.register(createBudgetReassurancePolicy());
  engine.register(createBudgetWarningPolicy());
  if (config.permissions) {
    engine.register(
      createToolPermissionPolicy({
        permission: config.permissions,
        eventEmitter: config.eventEmitter,
        source: "stream-engine",
      }),
    );
  }
  if (config.compaction) {
    engine.register(createCompactionPolicy(config.compaction));
  }
  if (config.memory) {
    engine.register(createMemoryPolicy(config.memory));
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

function assertNever(value: never): never {
  throw new Error(`Unhandled policy verdict: ${JSON.stringify(value)}`);
}

function createGuardCompleteEvent(
  state: StreamRunState,
  options?: { text?: string; steps?: AgentStep[]; finishReason?: "stop" | "stalled" },
): AgentEvent {
  return {
    type: "complete",
    result: {
      text: options?.text ?? state.lastAssistantText,
      steps: options?.steps ?? state.steps,
      usage: state.totalUsage,
      finishReason: options?.finishReason ?? "stop",
      guardAborted: true,
      compactionCount: getCompactionCount(state),
    },
  };
}

function publishDenyDiagnostic(
  timing: Policy.Timing,
  verdict: Extract<Policy.Verdict, { action: "deny" }>,
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase?: StreamAgentBase,
): void {
  Bus.publish(Operational.Info, {
    traceId: agentBase?.traceId ?? "stream-engine",
    time: Date.now(),
    sessionId: agentBase?.sessionId || undefined,
    component: "agent",
    msg: "agent.policy.deny.diagnostic",
    context: {
      timing,
      reason: verdict.reason,
      policyId: verdict.policyId,
      turns: state.budgetState.turns,
      elapsedMs: Date.now() - state.startTime,
    },
  });
  config.eventEmitter?.emit("agent.policy.deny", {
    sessionId: "stream-engine",
    time: Date.now(),
    timing,
    reason: verdict.reason,
    policyId: verdict.policyId,
  });
}

function buildToolLabelMap(tools: ChatAgentConfig["tools"]): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const tool of tools ?? []) {
    const labelledTool = tool as typeof tool & { labels?: string[] };
    if (!labelledTool.labels || labelledTool.labels.length === 0) continue;
    labels.set(tool.name, labelledTool.labels);
    const canonical = labelledTool.labels.find((label) => label.startsWith("tool:"))?.slice(5);
    if (canonical) labels.set(canonical, labelledTool.labels);
    const dotted = tool.name.replace(/_/g, ".");
    if (dotted !== tool.name) labels.set(dotted, labelledTool.labels);
  }
  return labels;
}

function resolvePolicyToolName(toolName: string, labels: Map<string, string[]>): string {
  const toolLabels = labels.get(toolName) ?? labels.get(toolName.replace(/_/g, "."));
  const canonical = toolLabels?.find((label) => label.startsWith("tool:"));
  return canonical ? canonical.slice(5) : toolName;
}

export async function dispatchPreRun(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
): Promise<AgentEvent | null> {
  const preRunVerdict = await engine.dispatchLegacy("run.start", {
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
  switch (preRunVerdict.action) {
    case "abort":
    case "deny":
      return createGuardCompleteEvent(state, { text: "", steps: [] });
    case "inject":
      state.messages.push(createUserMessage(preRunVerdict.message, "stream-engine"));
      return null;
    case "continue":
    case "skip":
    case "retry":
    case "transform":
      return null;
    default:
      return assertNever(preRunVerdict);
  }
}

export async function dispatchBudgetCheck(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): Promise<AgentEvent | null> {
  const budgetStatus = checkBudget(state.budgetState, config.budget);
  if (budgetStatus !== "exceeded") return null;

  const postRunVerdict = await engine.dispatchLegacy("run.finish", {
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
  switch (postRunVerdict.action) {
    case "transform": {
      const payload = postRunVerdict.input as { text?: unknown };
      if (typeof payload.text === "string") state.lastAssistantText = payload.text;
      break;
    }
    case "deny":
      publishDenyDiagnostic("run.finish", postRunVerdict, state, config, agentBase);
      break;
    case "continue":
    case "skip":
    case "abort":
    case "retry":
    case "inject":
      break;
    default:
      assertNever(postRunVerdict);
  }
  Bus.publish(Operational.Info, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId || undefined,
    component: "agent",
    msg: "agent.run.completed",
    context: {
      finishReason: "max-steps",
      turns: state.budgetState.turns,
      durationMs: Date.now() - state.startTime,
    },
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

export async function dispatchModelRequest(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
): Promise<AgentEvent | null> {
  const verdict = await engine.dispatchLegacy("model.request", {
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

  switch (verdict.action) {
    case "abort":
    case "deny":
      return createGuardCompleteEvent(state);
    case "continue":
    case "skip":
    case "retry":
    case "transform":
    case "inject":
      return null;
    default:
      return assertNever(verdict);
  }
}

export async function dispatchModelResponse(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  outcomeType: string,
): Promise<AgentEvent | null> {
  const verdict = await engine.dispatchLegacy("model.response", {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: outcomeType === "stop",
    continuationCount: state.continuationCount,
    elapsedMs: Date.now() - state.startTime,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
    toolInput: { outcomeType },
  });

  switch (verdict.action) {
    case "transform": {
      const payload = verdict.input as { text?: unknown };
      if (typeof payload.text === "string") state.lastAssistantText = payload.text;
      return null;
    }
    case "abort":
      return createGuardCompleteEvent(state);
    case "deny":
      publishDenyDiagnostic("model.response", verdict, state, config);
      return null;
    case "continue":
    case "skip":
    case "retry":
    case "inject":
      return null;
    default:
      return assertNever(verdict);
  }
}

export function emitTurnStart(
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
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
}

export function emitTurnComplete(
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  turnUsage: TokenUsage,
): void {
  config.eventEmitter?.emit("agent.turn.complete", {
    sessionId: "stream-engine",
    time: Date.now(),
    turnIndex: state.turnIndex,
    usage: {
      inputTokens: turnUsage.inputTokens,
      outputTokens: turnUsage.outputTokens,
      totalTokens: turnUsage.totalTokens,
    },
  });
  Bus.publish(AgentExecution.TurnComplete, {
    ...agentBase,
    time: Date.now(),
    turnIndex: state.turnIndex,
    usage: {
      inputTokens: turnUsage.inputTokens,
      outputTokens: turnUsage.outputTokens,
      totalTokens: turnUsage.totalTokens,
    },
  });
}

export async function buildTurn(
  state: StreamRunState,
  config: ChatAgentConfig,
  engine: PolicyEngineInstance,
  providerModel: RunInput["model"],
  configuredToolChoice: RunInput["toolChoice"],
  trace: TraceContext.Type,
  agentBase: StreamAgentBase,
  sink?: Sink,
): Promise<BuildTurnResult> {
  const preTurnVerdict = await engine.dispatchLegacy("turn.start", {
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
  switch (preTurnVerdict.action) {
    case "inject":
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
      break;
    case "abort":
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
    case "deny":
      return { type: "complete", event: createGuardCompleteEvent(state) };
    case "continue":
    case "skip":
    case "retry":
    case "transform":
      break;
    default:
      assertNever(preTurnVerdict);
  }

  state.budgetState = recordTurn(state.budgetState);
  if (config.signal?.aborted) throw new Error("aborted");

  const preToolUseVerdicts: Policy.Verdict[] = [];
  const toolLabels = buildToolLabelMap(config.tools);
  const hookedExecutor = config.toolExecutor
    ? createToolExecutor({
        toolExecutor: config.toolExecutor,
        engine,
        getPolicyToolName: (toolName) => resolvePolicyToolName(toolName, toolLabels),
        getToolLabels: (toolName) => toolLabels.get(toolName),
        onToolComplete: (durationMs) => {
          state.budgetState = recordToolCall(state.budgetState, durationMs);
        },
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

  // resources.prepare — policies can filter/modify tools exposed to LLM
  const allTools = config.tools ?? [];
  const catalogLabels: Policy.LabelEntry[] = [];
  for (const [name, labels] of toolLabels) {
    for (const label of labels) {
      catalogLabels.push({ value: `${name}:${label}`, source: "tool_metadata" });
    }
  }
  const toolSelectionVerdict = await engine.dispatchLegacy("resources.prepare", {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: false,
    continuationCount: state.continuationCount,
    elapsedMs: Date.now() - state.startTime,
    messages: state.messages,
    labels: catalogLabels,
  });

  let selectedTools = allTools;
  switch (toolSelectionVerdict.action) {
    case "transform": {
      const input = toolSelectionVerdict.input as { tools?: unknown };
      if (Array.isArray(input.tools)) {
        const allowed = new Set(input.tools as string[]);
        selectedTools = allTools.filter((t) => allowed.has(t.name));
      }
      break;
    }
    case "abort":
    case "deny":
      return { type: "complete", event: createGuardCompleteEvent(state) };
    case "continue":
    case "skip":
    case "retry":
    case "inject":
      break;
    default:
      assertNever(toolSelectionVerdict);
  }

  const turnUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const turnToolCalls: TurnArtifacts["turnToolCalls"] = [];
  const turnToolResults: TurnArtifacts["turnToolResults"] = [];
  const trackingSink = createTrackingSink(state, sink, turnUsage, turnToolCalls, turnToolResults);

  return {
    type: "ready",
    budgetReassuranceEvent,
    budgetWarningEvent,
    turn: {
      runInput: {
        messages: state.messages,
        tools: selectedTools,
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
  engine: PolicyEngineInstance,
  agentBase: StreamAgentBase,
  turn: TurnArtifacts,
): AsyncGenerator<AgentEvent, "complete" | "continue"> {
  emitTurnComplete(state, config, agentBase, turn.turnUsage);

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
      timing: "invoke.prepare",
      action: verdict.action,
      reason: "reason" in verdict ? verdict.reason : undefined,
    };
  }

  yield { type: "turn_complete", turnIndex: state.turnIndex, usage: turn.turnUsage };

  const step: AgentStep = { type: "text", content: state.lastAssistantText };
  state.steps.push(step);
  if (config.onStepFinish) await config.onStepFinish(step);

  const postTurnVerdict = await engine.dispatchLegacy("turn.finish", {
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
    timing: "turn.finish",
    action: postTurnVerdict.action,
    reason: "reason" in postTurnVerdict ? postTurnVerdict.reason : undefined,
  };

  switch (postTurnVerdict.action) {
    case "inject": {
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
    case "abort": {
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
    case "deny":
      publishDenyDiagnostic("turn.finish", postTurnVerdict, state, config, agentBase);
      break;
    case "continue":
    case "skip":
    case "retry":
    case "transform":
      break;
    default:
      assertNever(postTurnVerdict);
  }

  await dispatchPostRunTransform(state, engine, config);
  Bus.publish(Operational.Info, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId || undefined,
    component: "agent",
    msg: "agent.run.completed",
    context: {
      finishReason: "stop",
      turns: state.budgetState.turns,
      durationMs: Date.now() - state.startTime,
    },
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
  turnUsage: TokenUsage,
): AsyncGenerator<AgentEvent, "continue"> {
  emitTurnComplete(state, config, agentBase, turnUsage);
  yield { type: "turn_complete", turnIndex: state.turnIndex, usage: turnUsage };
  state.turnIndex++;
  return continueFlowDecision(continueDecision(state));
}

export async function handleCompact(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): Promise<"continue"> {
  await applyPostCompaction(state, engine, config, agentBase, false);
  state.turnIndex++;
  return continueFlowDecision(continueDecision(state));
}

export async function dispatchWritebackCommit(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  output: string,
): Promise<string> {
  const verdict = await engine.dispatchLegacy("writeback.commit", {
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
    toolInput: { output },
  });

  switch (verdict.action) {
    case "transform": {
      const input = verdict.input as { output?: unknown };
      return typeof input.output === "string" ? input.output : output;
    }
    case "abort":
      throw new Error(verdict.reason ?? "writeback.commit policy aborted");
    case "deny":
      throw new Error(verdict.reason ?? "writeback.commit policy denied");
    case "continue":
    case "skip":
    case "retry":
    case "inject":
      return output;
    default:
      return assertNever(verdict);
  }
}

export async function* handleError(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  error: unknown,
  attempt: number,
  retryPolicy: Parameters<typeof Retry.shouldAgentRetry>[0],
): AsyncGenerator<AgentEvent, ErrorDecision> {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const onErrorVerdict = await engine.dispatchLegacy("error", {
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

  switch (onErrorVerdict.action) {
    case "abort": {
      const event: AgentEvent = createGuardCompleteEvent(state);
      yield event;
      return { action: "complete", kind: "abort", event, errorMessage: normalizedError.message };
    }
    case "deny":
      publishDenyDiagnostic("error", onErrorVerdict, state, config, agentBase);
      break;
    case "continue":
    case "skip":
    case "retry":
    case "transform":
    case "inject":
      break;
    default:
      assertNever(onErrorVerdict);
  }

  const lastError = normalizedError.message;
  const retryReason = Retry.classifyAgentRetryReason(lastError);

  if (Retry.shouldAgentRetry(retryPolicy, retryReason, attempt)) {
    const backoffMs = Retry.calculateAgentBackoffMs(retryPolicy, attempt);
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
    yield {
      type: "error",
      error: normalizedError,
      willRetry: true,
    };
    await Retry.agentSleep(backoffMs);
    return { action: "retry", kind: "error", error: normalizedError, errorMessage: lastError };
  }

  Bus.publish(Operational.Error, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId || undefined,
    component: "agent",
    msg: "agent.run.failed",
    error: lastError,
  });
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
  engine: PolicyEngineInstance,
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
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
): Promise<void> {
  const postRunVerdict = await engine.dispatchLegacy("run.finish", {
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
  switch (postRunVerdict.action) {
    case "transform": {
      const payload = postRunVerdict.input as { text?: unknown };
      if (typeof payload.text === "string") state.lastAssistantText = payload.text;
      break;
    }
    case "deny":
      publishDenyDiagnostic("run.finish", postRunVerdict, state, config);
      break;
    case "continue":
    case "skip":
    case "abort":
    case "retry":
    case "inject":
      break;
    default:
      assertNever(postRunVerdict);
  }
}

async function applyPostCompaction(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  isCompletion: boolean,
): Promise<void> {
  const compactionVerdict = await engine.dispatchLegacy("completion.prepare", {
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
  switch (compactionVerdict.action) {
    case "transform": {
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
      break;
    }
    case "deny":
      publishDenyDiagnostic("completion.prepare", compactionVerdict, state, config, agentBase);
      break;
    case "continue":
    case "skip":
    case "abort":
    case "retry":
    case "inject":
      break;
    default:
      assertNever(compactionVerdict);
  }
}

function getCompactionCount(state: StreamRunState): number | undefined {
  return state.compactionCount > 0 ? state.compactionCount : undefined;
}
