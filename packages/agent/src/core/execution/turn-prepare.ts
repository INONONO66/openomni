import type { RunInput } from "@openomni/llm";
import { type Message, PolicyDecision } from "@openomni/protocol";
import type { Policy, Sink, TraceContext } from "@openomni/protocol";
import { describeBudgetRemaining, effectiveBudgetThresholds } from "../budget";
import type { PolicyEngineInstance } from "../policy";
import type { AgentEvent, ChatAgentConfig, TokenUsage } from "../types";
import { createToolExecutor } from "./tool-executor";
import { emitBudgetReassurance, emitBudgetWarning } from "./run-events";
import { buildLifecyclePolicyContext } from "./lifecycle-context";
import { buildTurnSystemPrompt } from "./prompt-policy";
import { PolicyEffectApplier } from "./policy-effects-apply";
import { createGuardCompleteEvent, createRunCompleteEvent } from "./run-result";
import type { BuildTurnResult, AgentRunBase, RunState, TurnArtifacts } from "./run-state";
import {
  recordAssistantTokenDelta,
  recordRunToolCall,
  recordRunTurn,
  setLastAssistantText,
} from "./run-state";

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

type ToolPolicyMetadata = Pick<NonNullable<ChatAgentConfig["tools"]>[number], "descriptor"> & {
  readonly labels?: readonly string[];
};

function buildToolMetadataMap(tools: ChatAgentConfig["tools"]): Map<string, ToolPolicyMetadata> {
  const metadata = new Map<string, ToolPolicyMetadata>();
  for (const tool of tools ?? []) {
    const labels = tool.labels ?? tool.descriptor?.labels;
    if (labels === undefined && tool.descriptor === undefined) continue;
    const value = {
      ...(labels !== undefined && { labels }),
      ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
    };
    metadata.set(tool.name, value);
    const canonical = labels?.find((label) => label.startsWith("tool:"))?.slice(5);
    if (canonical) metadata.set(canonical, value);
    const dotted = tool.name.replace(/_/g, ".");
    if (dotted !== tool.name) metadata.set(dotted, value);
  }
  return metadata;
}

function resolvePolicyToolName(
  toolName: string,
  metadata: Map<string, ToolPolicyMetadata>,
): string {
  const toolMetadata = metadata.get(toolName) ?? metadata.get(toolName.replace(/_/g, "."));
  const canonical = toolMetadata?.labels?.find((label) => label.startsWith("tool:"));
  return canonical ? canonical.slice(5) : toolName;
}

export async function buildTurn(
  state: RunState,
  config: ChatAgentConfig,
  engine: PolicyEngineInstance,
  providerModel: RunInput["model"],
  configuredToolChoice: RunInput["toolChoice"],
  trace: TraceContext.Type,
  agentBase: AgentRunBase,
  sink?: Sink,
): Promise<BuildTurnResult> {
  const preTurnDecision = await engine.dispatchPoint(
    "run.turn.pre",
    buildLifecyclePolicyContext(state, config, agentBase, { turnIndex: state.turnIndex }),
  );

  let budgetReassuranceEvent: Extract<AgentEvent, { type: "budget_reassurance" }> | undefined;
  let budgetWarningEvent: Extract<AgentEvent, { type: "budget_warning" }> | undefined;
  if (PolicyDecision.isBlocking(preTurnDecision)) {
    const reason = PolicyDecision.reason(preTurnDecision, "stop");
    return {
      type: "complete",
      event: createRunCompleteEvent(state, {
        finishReason: reason === "stalled" ? "stalled" : "stop",
        guardAborted: reason !== "stalled",
      }),
    };
  }

  PolicyEffectApplier.applyPromptMessageEffects(state, preTurnDecision);

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

  recordRunTurn(state);
  if (config.signal?.aborted) throw new Error("aborted");

  const toolPolicyDecisions: Array<{ timing: Policy.Timing; decision: Policy.PolicyDecision }> = [];
  const toolMetadata = buildToolMetadataMap(config.tools);
  const hookedExecutor = config.toolExecutor
    ? createToolExecutor({
        toolExecutor: config.toolExecutor,
        engine,
        getPolicyToolName: (toolName) => resolvePolicyToolName(toolName, toolMetadata),
        getToolLabels: (toolName) => toolMetadata.get(toolName)?.labels,
        getToolDescriptor: (toolName) => toolMetadata.get(toolName)?.descriptor,
        onToolComplete: (durationMs) => {
          recordRunToolCall(state, durationMs);
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

  const systemResult = await buildTurnSystemPrompt(state, config, engine, agentBase);
  if (systemResult.blocked) {
    return { type: "complete", event: createGuardCompleteEvent(state) };
  }
  const system = systemResult.system;

  const allTools = config.tools ?? [];
  const catalogLabels: Policy.LabelEntry[] = [];
  for (const [name, metadata] of toolMetadata) {
    for (const label of metadata.labels ?? []) {
      catalogLabels.push({ value: `${name}:${label}`, source: "tool_metadata" });
    }
  }
  const toolSelectionDecision = await engine.dispatchPoint(
    "tool.catalog.pre",
    buildLifecyclePolicyContext(state, config, agentBase, {
      labels: catalogLabels,
      availableTools: allTools,
    }),
  );

  if (PolicyDecision.isBlocking(toolSelectionDecision)) {
    return { type: "complete", event: createGuardCompleteEvent(state) };
  }
  const selectedTools = PolicyEffectApplier.applyToolFilterEffects(allTools, toolSelectionDecision);

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
        environment: config.environment,
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
  state: RunState,
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
