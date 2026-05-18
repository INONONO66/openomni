import type { RunInput } from "@openomni/llm";
import { AgentExecution, Message, Operational, PolicyDecision } from "@openomni/protocol";
import type { Policy, Sink, Tool, TraceContext } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { effectOf, effectsOf, matchesToolPattern } from "./policy-effects";
import {
  checkBudget,
  createBudgetState,
  describeBudgetRemaining,
  effectiveBudgetThresholds,
  recordToolCall,
  recordTokenUsage,
  recordTurn,
} from "../budget";
import type { BudgetState } from "../budget";
import { createAssistantMessage, createUserMessage } from "../message-factory";
import { PolicyEngine } from "../policy";
import type { DispatchContext, PolicyEngineInstance } from "../policy";
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
  readonly sessionId: string;
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
  readonly toolPolicyDecisions: Array<{
    readonly timing: Policy.Timing;
    readonly decision: Policy.PolicyDecision;
  }>;
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
  const sessionId = input.traceContext?.sessionId ?? "stream-engine";
  return {
    sessionId,
    budgetState: createBudgetState(),
    messages: toMessagesWithParts(input.messages, sessionId),
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

function injectedPrompts(decision: Policy.PolicyDecision): string[] {
  const prompts: string[] = [];
  for (const effect of decision.effects) {
    if (effect.type === "prompt.inject_message") prompts.push(effect.message);
    if (effect.type === "run.continue_with_prompt") prompts.push(effect.prompt);
  }
  return prompts;
}

function replacementMessages(decision: Policy.PolicyDecision): Message.WithParts[] | undefined {
  const effect = effectOf(decision, "run.replace_messages");
  if (!effect) return undefined;

  const parsed = Message.WithParts.array().safeParse(effect.messages);
  if (!parsed.success) {
    throw new Error("policy.invalid_replacement_messages");
  }
  return parsed.data;
}

function applyPromptMessageEffects(state: StreamRunState, decision: Policy.PolicyDecision): void {
  for (const effect of decision.effects) {
    if (effect.type === "prompt.inject_message") {
      state.messages.push(createUserMessage(effect.message, state.sessionId));
    } else if (effect.type === "prompt.append_context") {
      state.messages.push(createUserMessage(effect.context, state.sessionId));
    }
  }
}

function applyMessageReplacementEffect(
  state: StreamRunState,
  decision: Policy.PolicyDecision,
): void {
  const messages = replacementMessages(decision);
  if (messages !== undefined) state.messages = messages;
}

function applyToolFilterEffects(
  tools: NonNullable<ChatAgentConfig["tools"]>,
  decision: Policy.PolicyDecision,
): NonNullable<ChatAgentConfig["tools"]> {
  const filters = effectsOf(decision, "tool.filter");
  if (filters.length === 0) return tools;
  return tools.filter(
    (tool) => !filters.some((effect) => matchesToolPattern(tool.name, effect.toolPattern)),
  );
}

function publishDenyDiagnostic(
  timing: Policy.Timing,
  decision: Policy.PolicyDecision,
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase?: StreamAgentBase,
): void {
  const reason = PolicyDecision.reason(decision, "denied");
  Bus.publish(Operational.Info, {
    traceId: agentBase?.traceId ?? "stream-engine",
    time: Date.now(),
    sessionId: agentBase?.sessionId || undefined,
    component: "agent",
    msg: "agent.policy.deny.diagnostic",
    context: {
      timing,
      reason,
      policyId: decision.policyId,
      turns: state.budgetState.turns,
      elapsedMs: Date.now() - state.startTime,
    },
  });
  config.eventEmitter?.emit("agent.policy.deny", {
    sessionId: state.sessionId,
    time: Date.now(),
    timing,
    reason,
    policyId: decision.policyId,
  });
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

type LifecyclePolicyContextOverrides = Partial<
  Pick<
    DispatchContext,
    "turnCount" | "continuationCount" | "elapsedMs" | "isCompletion" | "toolInput"
  >
>;

function buildLifecyclePolicyContext(
  state: StreamRunState,
  config: ChatAgentConfig,
  overrides: LifecyclePolicyContextOverrides = {},
): DispatchContext {
  const { elapsedMs = Date.now() - state.startTime, ...rest } = overrides;
  return {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: false,
    continuationCount: state.continuationCount,
    elapsedMs,
    messages: state.messages,
    budgetState: state.budgetState,
    budget: config.budget,
    eventEmitter: config.eventEmitter,
    ...rest,
  };
}

export async function dispatchPreRun(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
): Promise<AgentEvent | null> {
  const preRunDecision = await engine.dispatch(
    "run.start",
    buildLifecyclePolicyContext(state, config, {
      turnCount: 0,
      continuationCount: 0,
      elapsedMs: 0,
    }),
  );

  if (PolicyDecision.isBlocking(preRunDecision)) {
    return createGuardCompleteEvent(state, { text: "", steps: [] });
  }

  applyPromptMessageEffects(state, preRunDecision);
  return null;
}

export async function dispatchBudgetCheck(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): Promise<AgentEvent | null> {
  const budgetStatus = checkBudget(state.budgetState, config.budget);
  if (budgetStatus !== "exceeded") return null;

  const postRunDecision = await engine.dispatch(
    "run.finish",
    buildLifecyclePolicyContext(state, config, {
      isCompletion: true,
    }),
  );
  if (PolicyDecision.isBlocking(postRunDecision)) {
    publishDenyDiagnostic("run.finish", postRunDecision, state, config, agentBase);
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
  const decision = await engine.dispatch(
    "model.request",
    buildLifecyclePolicyContext(state, config),
  );

  if (PolicyDecision.isBlocking(decision)) return createGuardCompleteEvent(state);
  applyPromptMessageEffects(state, decision);
  return null;
}

export async function dispatchModelResponse(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  outcomeType: string,
): Promise<AgentEvent | null> {
  const decision = await engine.dispatch(
    "model.response",
    buildLifecyclePolicyContext(state, config, {
      isCompletion: outcomeType === "stop",
      toolInput: { outcomeType },
    }),
  );

  if (!PolicyDecision.isBlocking(decision)) {
    try {
      applyMessageReplacementEffect(state, decision);
    } catch (error) {
      publishDenyDiagnostic(
        "model.response",
        PolicyDecision.deny({
          policyId: "agent.policy.composed",
          reasonCodes: [(error as Error).message],
          effects: [{ type: "run.abort", reason: (error as Error).message }],
        }),
        state,
        config,
      );
      return createGuardCompleteEvent(state);
    }
    applyPromptMessageEffects(state, decision);
    return null;
  }
  if (effectOf(decision, "run.abort")) return createGuardCompleteEvent(state);
  publishDenyDiagnostic("model.response", decision, state, config);
  return null;
}

export function emitTurnStart(
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): void {
  config.eventEmitter?.emit("agent.turn.start", {
    sessionId: state.sessionId,
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
    sessionId: state.sessionId,
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
  const preTurnDecision = await engine.dispatch(
    "turn.start",
    buildLifecyclePolicyContext(state, config),
  );

  let budgetReassuranceEvent: Extract<AgentEvent, { type: "budget_reassurance" }> | undefined;
  let budgetWarningEvent: Extract<AgentEvent, { type: "budget_warning" }> | undefined;
  if (PolicyDecision.isBlocking(preTurnDecision)) {
    const reason = PolicyDecision.reason(preTurnDecision, "stop");
    return {
      type: "complete",
      event: {
        type: "complete",
        result: {
          text: state.lastAssistantText,
          steps: state.steps,
          usage: state.totalUsage,
          finishReason: reason === "stalled" ? "stalled" : "stop",
          guardAborted: reason !== "stalled",
          compactionCount: getCompactionCount(state),
        },
      },
    };
  }

  applyPromptMessageEffects(state, preTurnDecision);

  if (preTurnDecision.reasonCodes.includes("budget_reassurance")) {
    const remaining = describeBudgetRemaining(state.budgetState, config.budget);
    Bus.publish(AgentExecution.BudgetReassurance, {
      ...agentBase,
      time: Date.now(),
      remaining,
      threshold: effectiveBudgetThresholds(config.budget).reassuranceThreshold,
    });
    budgetReassuranceEvent = { type: "budget_reassurance", remaining };
  }
  if (preTurnDecision.reasonCodes.includes("budget_warning")) {
    const remaining = describeBudgetRemaining(state.budgetState, config.budget);
    Bus.publish(AgentExecution.BudgetWarning, {
      ...agentBase,
      time: Date.now(),
      remaining,
      threshold: effectiveBudgetThresholds(config.budget).warningThreshold,
    });
    budgetWarningEvent = { type: "budget_warning", remaining };
  }

  state.budgetState = recordTurn(state.budgetState);
  if (config.signal?.aborted) throw new Error("aborted");

  const toolPolicyDecisions: Array<{ timing: Policy.Timing; decision: Policy.PolicyDecision }> = [];
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
        onDecision: (timing, decision) => {
          toolPolicyDecisions.push({ timing, decision });
        },
        traceContext: trace,
        signal: config.signal,
      })
    : undefined;

  const systemResult = await buildTurnSystemPrompt(state, config, engine);
  if (systemResult.blocked) {
    return { type: "complete", event: createGuardCompleteEvent(state) };
  }
  const system = systemResult.system;

  // resources.prepare — policies can filter/modify tools exposed to LLM
  const allTools = config.tools ?? [];
  const catalogLabels: Policy.LabelEntry[] = [];
  for (const [name, labels] of toolLabels) {
    for (const label of labels) {
      catalogLabels.push({ value: `${name}:${label}`, source: "tool_metadata" });
    }
  }
  const toolSelectionDecision = await engine.dispatch("resources.prepare", {
    steps: state.steps,
    usage: state.totalUsage,
    turnCount: state.budgetState.turns,
    isCompletion: false,
    continuationCount: state.continuationCount,
    elapsedMs: Date.now() - state.startTime,
    messages: state.messages,
    labels: catalogLabels,
  });

  if (PolicyDecision.isBlocking(toolSelectionDecision)) {
    return { type: "complete", event: createGuardCompleteEvent(state) };
  }
  const selectedTools = applyToolFilterEffects(allTools, toolSelectionDecision);

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
        auth: config.auth,
        allowAuthFallback: config.allowAuthFallback,
        toolExecutor: hookedExecutor,
        toolChoice: configuredToolChoice,
        maxSteps: config.budget?.maxToolCalls ?? 24,
        providerOptions: config.providerOptions,
        trace: {
          traceId: trace.traceId,
          ...(trace.runId !== undefined && { runId: trace.runId }),
        },
      },
      trackingSink,
      turnUsage,
      turnToolCalls,
      turnToolResults,
      toolPolicyDecisions,
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
  for (const entry of turn.toolPolicyDecisions) {
    yield {
      type: "hook_verdict",
      timing: entry.timing,
      action: entry.decision.verdict,
      reason: PolicyDecision.reason(entry.decision, undefined),
    };
  }

  const toolAbort = turn.toolPolicyDecisions.find(
    (entry) => PolicyDecision.isBlocking(entry.decision) && effectOf(entry.decision, "run.abort"),
  );

  yield { type: "turn_complete", turnIndex: state.turnIndex, usage: turn.turnUsage };

  const step: AgentStep = { type: "text", content: state.lastAssistantText };
  state.steps.push(step);
  if (config.onStepFinish) await config.onStepFinish(step);

  if (toolAbort) {
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
    return "complete";
  }

  const postTurnDecision = await engine.dispatch(
    "turn.finish",
    buildLifecyclePolicyContext(state, config, {
      isCompletion: true,
    }),
  );

  yield {
    type: "hook_verdict",
    timing: "turn.finish",
    action: postTurnDecision.verdict,
    reason: PolicyDecision.reason(postTurnDecision, undefined),
  };

  if (!PolicyDecision.isBlocking(postTurnDecision)) {
    try {
      applyMessageReplacementEffect(state, postTurnDecision);
    } catch (error) {
      publishDenyDiagnostic(
        "turn.finish",
        PolicyDecision.deny({
          policyId: "agent.policy.composed",
          reasonCodes: [(error as Error).message],
          effects: [{ type: "run.abort", reason: (error as Error).message }],
        }),
        state,
        config,
      );
      yield createGuardCompleteEvent(state);
      return "complete";
    }
  }

  const continuationPrompts = injectedPrompts(postTurnDecision);
  if (!PolicyDecision.isBlocking(postTurnDecision) && continuationPrompts.length > 0) {
    const parentID = state.messages.at(-1)?.info.id ?? "";
    state.messages.push(
      createAssistantMessage(state.lastAssistantText, parentID, state.sessionId),
      ...continuationPrompts.map((prompt) => createUserMessage(prompt, state.sessionId)),
    );
    const blocked = await applyPostCompaction(state, engine, config, agentBase, true);
    if (blocked) {
      yield blocked;
      return "complete";
    }
    state.continuationCount++;
    state.turnIndex++;
    return flowDecision(continueDecision(state));
  }

  if (PolicyDecision.isBlocking(postTurnDecision)) {
    const reason = PolicyDecision.reason(postTurnDecision, "stop");
    if (effectOf(postTurnDecision, "run.abort")) {
      const event: AgentEvent = {
        type: "complete",
        result: {
          text: state.lastAssistantText,
          steps: state.steps,
          usage: state.totalUsage,
          finishReason: reason === "stalled" ? "stalled" : "stop",
          guardAborted: reason !== "stalled",
          compactionCount: getCompactionCount(state),
        },
      };
      yield event;
      return flowDecision({ kind: "abort", event });
    }
    publishDenyDiagnostic("turn.finish", postTurnDecision, state, config, agentBase);
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
): Promise<"continue" | AgentEvent> {
  const blocked = await applyPostCompaction(state, engine, config, agentBase, false);
  if (blocked) return blocked;
  state.turnIndex++;
  return continueFlowDecision(continueDecision(state));
}

export async function dispatchWritebackCommit(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  output: string,
): Promise<string> {
  const decision = await engine.dispatch(
    "writeback.commit",
    buildLifecyclePolicyContext(state, config, {
      isCompletion: true,
      toolInput: { output },
    }),
  );

  if (PolicyDecision.isBlocking(decision)) {
    throw new Error(PolicyDecision.reason(decision, "writeback.commit policy denied"));
  }

  const suppress = effectOf(decision, "writeback.suppress");
  if (suppress) throw new Error(suppress.reason ?? "writeback.commit policy suppressed output");
  return effectOf(decision, "writeback.rewrite")?.output ?? output;
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
  const onErrorDecision = await engine.dispatch(
    "error",
    buildLifecyclePolicyContext(state, config, {
      toolInput: { error: normalizedError },
    }),
  );

  if (PolicyDecision.isBlocking(onErrorDecision)) {
    if (effectOf(onErrorDecision, "run.abort")) {
      const event: AgentEvent = createGuardCompleteEvent(state);
      yield event;
      return { action: "complete", kind: "abort", event, errorMessage: normalizedError.message };
    }
    publishDenyDiagnostic("error", onErrorDecision, state, config, agentBase);
  }

  const lastError = normalizedError.message;
  const retryReason = Retry.classifyAgentRetryReason(lastError);
  const retryEffect = effectOf(onErrorDecision, "run.retry_after");
  const effectiveRetryPolicy =
    retryEffect?.maxRetries === undefined
      ? retryPolicy
      : {
          ...retryPolicy,
          maxAttempts: Math.min(retryPolicy.maxAttempts, retryEffect.maxRetries),
        };

  if (Retry.shouldAgentRetry(effectiveRetryPolicy, retryReason, attempt)) {
    const backoffMs = retryEffect?.delayMs ?? Retry.calculateAgentBackoffMs(retryPolicy, attempt);
    config.eventEmitter?.emit("agent.error.retry", {
      sessionId: state.sessionId,
      time: Date.now(),
      attempt,
      maxAttempts: effectiveRetryPolicy.maxAttempts,
      error: lastError,
    });
    Bus.publish(AgentExecution.ErrorRetry, {
      ...agentBase,
      time: Date.now(),
      attempt,
      maxAttempts: effectiveRetryPolicy.maxAttempts,
      error: lastError,
    });
    yield {
      type: "error",
      error: normalizedError,
      willRetry: true,
    };
    await Retry.agentSleep(backoffMs, config.signal);
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
): Promise<{ system?: string; blocked?: Policy.PolicyDecision }> {
  let system = buildSystemPrompt(config.systemPrompt, config.tools ?? []);
  const decision = await engine.dispatch(
    "context.prepare",
    buildLifecyclePolicyContext(state, config),
  );
  if (PolicyDecision.isBlocking(decision)) return { system, blocked: decision };

  for (const effect of decision.effects) {
    if (effect.type === "prompt.replace") {
      system = effect.prompt;
    } else if (effect.type === "prompt.append_context") {
      system = system
        ? `${system}

${effect.context}`
        : effect.context;
    } else if (effect.type === "prompt.inject_message") {
      system = system
        ? `${system}

${effect.message}`
        : effect.message;
    }
  }
  return { system };
}

async function dispatchPostRunTransform(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
): Promise<void> {
  const postRunDecision = await engine.dispatch(
    "run.finish",
    buildLifecyclePolicyContext(state, config, {
      isCompletion: true,
    }),
  );
  if (PolicyDecision.isBlocking(postRunDecision)) {
    publishDenyDiagnostic("run.finish", postRunDecision, state, config);
  }
}

async function applyPostCompaction(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  isCompletion: boolean,
): Promise<AgentEvent | null> {
  const compactionDecision = await engine.dispatch(
    "completion.prepare",
    buildLifecyclePolicyContext(state, config, {
      isCompletion,
    }),
  );

  if (PolicyDecision.isBlocking(compactionDecision)) {
    publishDenyDiagnostic("completion.prepare", compactionDecision, state, config, agentBase);
    return createGuardCompleteEvent(state, { finishReason: "stop" });
  }

  let messages: Message.WithParts[] | undefined;
  try {
    messages = replacementMessages(compactionDecision);
  } catch (error) {
    publishDenyDiagnostic(
      "completion.prepare",
      PolicyDecision.deny({
        policyId: "agent.policy.composed",
        reasonCodes: [(error as Error).message],
        effects: [{ type: "run.abort", reason: (error as Error).message }],
      }),
      state,
      config,
      agentBase,
    );
    return createGuardCompleteEvent(state, { finishReason: "stop" });
  }
  if (messages !== undefined) {
    const messagesBefore = state.messages.length;
    state.messages = messages;
    state.compactionCount += 1;
    Bus.publish(AgentExecution.Compaction, {
      ...agentBase,
      time: Date.now(),
      messagesBefore,
      messagesAfter: state.messages.length,
    });
  }
  applyPromptMessageEffects(state, compactionDecision);

  return null;
}

function getCompactionCount(state: StreamRunState): number | undefined {
  return state.compactionCount > 0 ? state.compactionCount : undefined;
}
