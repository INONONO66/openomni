import type { RunInput } from "@openomni/llm";
import { type Message, PolicyDecision } from "@openomni/protocol";
import type { Policy, Sink, Tool } from "@openomni/protocol";
import { describeBudgetRemaining, effectiveBudgetThresholds } from "../budget";
import type { PolicyEngineInstance } from "../policy";
import type { ChatAgentConfig, TokenUsage } from "../types";
import { createToolExecutor } from "./tool-executor";
import {
  guardAbortedResult,
  runResult,
  emitBudgetReassurance,
  emitBudgetWarning,
} from "./run-events";
import { PolicyEffectApplier } from "./policy-effects";
import type { AgentRunBase, BuildTurnResult, RunState, RunTrace, TurnArtifacts } from "./run-state";
import {
  buildLifecyclePolicyContext,
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

// merged from prompt-builder.ts (fragment sweep: single-caller fn)
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
  trace: RunTrace,
  agentBase: AgentRunBase,
  sink?: Sink,
): Promise<BuildTurnResult> {
  const preTurnDecision = await engine.dispatchPoint(
    "run.turn.pre",
    buildLifecyclePolicyContext(state, config, agentBase, { turnIndex: state.turnIndex }),
  );

  if (PolicyDecision.isBlocking(preTurnDecision)) {
    const reason = PolicyDecision.reason(preTurnDecision, "stop");
    return {
      type: "complete",
      result: runResult(state, {
        finishReason: reason === "stalled" ? "stalled" : "stop",
        guardAborted: reason !== "stalled",
      }),
    };
  }

  PolicyEffectApplier.applyPromptMessageEffects(state, preTurnDecision);

  if (preTurnDecision.reasonCodes.includes("budget_reassurance")) {
    const remaining = describeBudgetRemaining(state.budgetState, config.budget);
    emitBudgetReassurance(
      config.events,
      agentBase,
      remaining,
      effectiveBudgetThresholds(config.budget).reassuranceThreshold,
    );
  }
  if (preTurnDecision.reasonCodes.includes("budget_warning")) {
    const remaining = describeBudgetRemaining(state.budgetState, config.budget);
    emitBudgetWarning(
      config.events,
      agentBase,
      remaining,
      effectiveBudgetThresholds(config.budget).warningThreshold,
    );
  }

  recordRunTurn(state);
  if (config.signal?.aborted) throw new Error("aborted");

  const toolPolicyDecisions: Array<{ timing: Policy.Timing; decision: Policy.PolicyDecision }> = [];
  const toolMetadata = buildToolMetadataMap(config.tools);
  const hookedExecutor = config.toolExecutor
    ? createToolExecutor({
        events: config.events,
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
    return { type: "complete", result: guardAbortedResult(state) };
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
    return { type: "complete", result: guardAbortedResult(state) };
  }
  const selectedTools = PolicyEffectApplier.applyToolFilterEffects(allTools, toolSelectionDecision);

  const turnUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const turnToolCalls: TurnArtifacts["turnToolCalls"] = [];
  const turnToolResults: TurnArtifacts["turnToolResults"] = [];
  const turnAssistant: TurnArtifacts["turnAssistant"] = {};
  const trackingSink = createTrackingSink(
    state,
    sink,
    turnUsage,
    turnToolCalls,
    turnToolResults,
    turnAssistant,
  );

  return {
    type: "ready",
    turn: {
      runInput: {
        // llm reports through the same port the agent was handed.
        events: config.events,
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
        trace: { traceId: trace.traceId, sessionId: trace.sessionId, runId: trace.runId },
      },
      trackingSink,
      turnAssistant,
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
  turnAssistant: TurnArtifacts["turnAssistant"],
): Sink {
  let prevInputTokens = 0;
  let prevOutputTokens = 0;

  return {
    onMessage: (message: Message.WithParts) => {
      if (message.info.role === "assistant") {
        // Boundary snapshots are immutable fold states (#557); the latest one
        // IS the turn's assistant message — full parts, tool use included.
        // Holding it (instead of re-extracting text) keeps one source of
        // truth for what enters history at turn end (#546).
        turnAssistant.message = message;
        // Tokens arrive once, stamped by message.finished; intermediate
        // boundary snapshots carry zeros, so this delta fires once per attempt.
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
    // #547 C3: the fact stream passes through untouched — the transcript
    // record family subscribes to facts, not boundary snapshots.
    onFact: (fact) => sink?.onFact?.(fact),
  };
}

// merged from prompt-policy.ts (250-LOC split refold: single-importer stage)
async function buildTurnSystemPrompt(
  state: RunState,
  config: ChatAgentConfig,
  engine: PolicyEngineInstance,
  agentBase: AgentRunBase,
): Promise<{ system?: string; blocked?: Policy.PolicyDecision }> {
  let system = buildSystemPrompt(config.systemPrompt, config.tools ?? []);
  const decision = await engine.dispatchPoint(
    "prompt.context.pre",
    buildLifecyclePolicyContext(state, config, agentBase, { turnIndex: state.turnIndex }),
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
