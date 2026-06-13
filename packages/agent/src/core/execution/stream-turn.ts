import type { RunInput } from "@openomni/llm";
import { type Message, PolicyDecision } from "@openomni/protocol";
import type { Policy, Sink, TraceContext } from "@openomni/protocol";
import { describeBudgetRemaining, effectiveBudgetThresholds } from "../budget";
import type { PolicyEngineInstance } from "../policy";
import type { AgentEvent, ChatAgentConfig, TokenUsage } from "../types";
import { createToolExecutor } from "./tool-executor";
import { emitBudgetReassurance, emitBudgetWarning } from "./stream-events";
import { buildLifecyclePolicyContext } from "./stream-policy-context";
import { buildTurnSystemPrompt } from "./stream-prompt-policy";
import { StreamPolicyEffects } from "./stream-policy-effects";
import { createGuardCompleteEvent, createStreamCompleteEvent } from "./stream-result";
import type {
  BuildTurnResult,
  StreamAgentBase,
  StreamRunState,
  TurnArtifacts,
} from "./stream-state";
import {
  recordAssistantTokenDelta,
  recordStreamToolCall,
  recordStreamTurn,
  setLastAssistantText,
} from "./stream-state";

export function resolveToolChoice(
  config: ChatAgentConfig,
): "auto" | "required" | "none" | undefined {
  return config.toolChoice;
}

export function assertToolExecutor(config: ChatAgentConfig): void {
  if ((config.tools?.length ?? 0) > 0 && !config.toolExecutor) {
    throw new Error("toolExecutor is required when tools are provided");
  }
}

function buildToolLabelMap(tools: ChatAgentConfig["tools"]): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const tool of tools ?? []) {
    if (!tool.labels || tool.labels.length === 0) continue;
    labels.set(tool.name, tool.labels);
    const canonical = tool.labels.find((label) => label.startsWith("tool:"))?.slice(5);
    if (canonical) labels.set(canonical, tool.labels);
    const dotted = tool.name.replace(/_/g, ".");
    if (dotted !== tool.name) labels.set(dotted, tool.labels);
  }
  return labels;
}

function resolvePolicyToolName(toolName: string, labels: Map<string, string[]>): string {
  const toolLabels = labels.get(toolName) ?? labels.get(toolName.replace(/_/g, "."));
  const canonical = toolLabels?.find((label) => label.startsWith("tool:"));
  return canonical ? canonical.slice(5) : toolName;
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
      event: createStreamCompleteEvent(state, {
        finishReason: reason === "stalled" ? "stalled" : "stop",
        guardAborted: reason !== "stalled",
      }),
    };
  }

  StreamPolicyEffects.applyPromptMessageEffects(state, preTurnDecision);

  if (preTurnDecision.reasonCodes.includes("budget_reassurance")) {
    const remaining = describeBudgetRemaining(state.budgetState, config.budget);
    emitBudgetReassurance(
      agentBase,
      remaining,
      effectiveBudgetThresholds(config.budget).reassuranceThreshold,
    );
    budgetReassuranceEvent = { type: "budget_reassurance", remaining };
  }
  if (preTurnDecision.reasonCodes.includes("budget_warning")) {
    const remaining = describeBudgetRemaining(state.budgetState, config.budget);
    emitBudgetWarning(
      agentBase,
      remaining,
      effectiveBudgetThresholds(config.budget).warningThreshold,
    );
    budgetWarningEvent = { type: "budget_warning", remaining };
  }

  recordStreamTurn(state);
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
          recordStreamToolCall(state, durationMs);
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
  const selectedTools = StreamPolicyEffects.applyToolFilterEffects(allTools, toolSelectionDecision);

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

function createTrackingSink(
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
        const tokens = message.info.tokens;
        const deltaInput = tokens.input - prevInputTokens;
        const deltaOutput = tokens.output - prevOutputTokens;
        prevInputTokens = tokens.input;
        prevOutputTokens = tokens.output;
        if (deltaInput > 0 || deltaOutput > 0) {
          turnUsage.inputTokens += deltaInput;
          turnUsage.outputTokens += deltaOutput;
          turnUsage.totalTokens += deltaInput + deltaOutput;
          recordAssistantTokenDelta(state, deltaInput, deltaOutput);
        }
      }
      const text = message.parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text) setLastAssistantText(state, text);
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
