import type { RunInput, Sink } from "@openomni/llm";
import { Placement } from "@openomni/placement";
import { type Message, Operational, Tool } from "@openomni/protocol";
import type { BusEvent } from "@openomni/protocol";
import { effectiveMaxToolCalls, recordToolCall } from "../budget";
import { Compaction, type CompactionSession } from "../../compaction";
import { resolveCompactionGeometry } from "../../compaction/geometry";
import { measuredContextTokens } from "../../compaction/measure";
import { createAssistantMessage } from "../message-factory";
import * as Retry from "../retry";
import type { AgentResult, ChatAgentConfig, TokenUsage } from "../types";
import { emitErrorRetry, emitTurnComplete, runResult } from "./run-events";
import {
  advanceRunTurn,
  applyCompactionMessages,
  disarmWindowYield,
  appendRunMessages,
  appendRunStep,
  recordAssistantTokenDelta,
  recordCallContext,
  recordRunTurn,
  setLastAssistantText,
  type AgentRunBase,
  type BuildTurnResult,
  type ErrorDecision,
  type RunState,
  type RunTrace,
  type TurnArtifacts,
} from "./state";

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

/**
 * Config-time validation: building the metadata map throws on a key
 * collision (see {@link buildToolMetadataMap}). Run alongside
 * `assertToolExecutor` so an ambiguous catalog refuses the run before it is
 * opened, instead of surfacing mid-turn as a retryable "tool" error.
 */
export function assertUnambiguousToolMetadata(config: ChatAgentConfig): void {
  buildToolMetadataMap(config.tools);
}

/**
 * Placement decides EXECUTION, not just advertisement. Filtering the catalog
 * only stops the model from being told about a tool; a model that names a
 * placement-filtered tool anyway (forged call, stale transcript, cached
 * catalog) must still be refused, or the capability requirement is
 * decorative. This wrapper is the single enforcement point for that refusal.
 *
 * It refuses ONLY tools this run's placement fold declared unofferable, under
 * every identity an executor can dispatch them by (`Tool.executableNames`).
 * Reservation is unconditional: a catalog where an offerable tool's literal
 * name is also a refused tool's alias is ambiguous at the executor's own
 * dispatch table, so the gate fails closed rather than resolving it by
 * catalog order. A name absent from the configured catalog is not a placement
 * matter — dynamic executors (MCP relays, host-registered tools) legitimately
 * resolve names the loop never listed, and rejecting those here would be
 * placement overreaching into tool resolution.
 *
 * `Placement.resolveTools` answers only what may be OFFERED, so this wrapper
 * is the other half: it refuses a call to a tool the placement fold declined
 * to offer, naming what was missing. Exported because every door into a tool
 * catalog needs it, and a second spelling of this refusal is how the two
 * would drift — the loop applies it to what the model calls; a host that
 * lets code call tools directly applies it to that door, which the loop
 * never sees.
 */
export function placementGatedExecutor(
  decisions: readonly Placement.ToolDecision[],
  execute: NonNullable<ChatAgentConfig["toolExecutor"]>,
): NonNullable<ChatAgentConfig["toolExecutor"]> {
  const refused = new Map<string, NonNullable<Tool.Spec["requires"]>>();
  for (const decision of decisions) {
    if (decision.offerable) continue;
    const requires = decision.tool.requires ?? [];
    for (const name of Tool.executableNames(decision.tool.name)) refused.set(name, requires);
  }
  if (refused.size === 0) return execute;
  return async (call, context) => {
    const requires = refused.get(call.tool);
    if (requires === undefined) return execute(call, context);
    return {
      id: call.id,
      toolCallId: call.id,
      toolName: call.tool,
      output: `tool "${call.tool}" requires capabilities no attached target holds: ${requires.join(", ")}`,
      isError: true,
      settlement: "settled",
    } as const;
  };
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
      throw new Error(
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

function prepareTurnTools(state: RunState, config: ChatAgentConfig): PreparedTurnTools {
  const toolTargets = config.toolTargets ?? [{ kind: "host", capabilities: [] } as const];
  const placement = Placement.resolveTools(config.tools ?? [], toolTargets);
  const allTools = placement
    .filter((decision) => decision.offerable)
    .map((decision) => decision.tool);
  const configuredExecutor = config.toolExecutor;
  const executor = configuredExecutor
    ? placementGatedExecutor(placement, async (call, context) => {
        const startedAt = Date.now();
        try {
          return await configuredExecutor(call, context);
        } finally {
          state.budgetState = recordToolCall(state.budgetState, Date.now() - startedAt);
        }
      })
    : undefined;
  return { allTools, executor };
}

export async function buildTurn(
  state: RunState,
  config: ChatAgentConfig,
  providerModel: RunInput["model"],
  configuredToolChoice: RunInput["toolChoice"],
  trace: RunTrace,
  sink?: Sink,
): Promise<BuildTurnResult> {
  recordRunTurn(state);
  if (config.signal?.aborted) throw Retry.abortError();

  const tools = prepareTurnTools(state, config);
  const system = buildSystemPrompt(config.systemPrompt, tools.allTools);
  const selectedTools = tools.allTools;

  const turnUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  // The step cap is the REMAINING budget from the pool the budget actually
  // enforces (-1 = unlimited): a yielded-and-continued run re-enters here,
  // and a cap from any other pool starves or multiplies what an operator
  // sized once. Tool calls and steps are different units — a parallel-call
  // step spends several from the pool — so the cap is conservative, and an
  // early end is a lossless re-entry, not a loss.
  const toolCallPool = effectiveMaxToolCalls(config.budget);
  const stepCap =
    toolCallPool === -1
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, toolCallPool - state.budgetState.toolCalls);
  const yieldAtInputTokens =
    state.contextWindowTokens === undefined || state.windowYieldDisarmed === true
      ? undefined
      : Math.floor(
          resolveCompactionGeometry({
            contextWindowTokens: state.contextWindowTokens,
            ...(state.lastCompactionYield === undefined
              ? {}
              : { previousYield: state.lastCompactionYield }),
          }).thresholdTokens,
        );
  const turnAssistant: TurnArtifacts["turnAssistant"] = {};
  const trackingSink = createTrackingSink(state, sink, turnUsage, turnAssistant);
  // Steering (#751): the host check is wrapped so the turn records WHY the
  // loop stopped — without the flag, a steering yield below the step cap is
  // indistinguishable from a cap end and would terminate as "max-steps".
  const steering: TurnArtifacts["steering"] = { requested: false };
  const steeringPending = config.steeringPending;

  return {
    type: "ready",
    turn: {
      runInput: {
        events: config.events,
        // ALIASING INVARIANT: this is `state.messages` itself, not a copy.
        // Effects that append to run history between here and the llm call
        // (prompt injections, continuation messages) are visible to this
        // turn's model input by design; effects that REPLACE history
        // (`replaceRunMessages`) swap the array and are deliberately NOT
        // visible to an already-built turn. Do not "fix" either direction.
        messages: state.messages,
        tools: selectedTools,
        system,
        signal: config.signal,
        model: providerModel,
        // The configured API key belongs to the primary provider. A
        // cross-provider fallback must resolve that provider's credential in
        // llm.run rather than forwarding the primary key to it.
        auth: providerModel.providerID === config.model.provider ? config.auth : undefined,
        ...(config.transport === undefined ? {} : { transport: config.transport }),
        allowAuthFallback: config.allowAuthFallback,
        toolExecutor: tools.executor,
        toolChoice: configuredToolChoice,
        maxSteps: stepCap,
        // Agent owns retry attempts, their backoff, and fallback selection.
        // Disable llm.run's nested transport retries for this orchestrated path;
        // standalone callers retain llm's bounded default when this is absent.
        maxRetryAttempts: 0,
        // Yield at the same ratio the compaction trigger defaults to: the
        // loop stops at a step boundary once the window fills, the seam
        // below gets its chance on every path — Resident and tool loops
        // included, not just injected continuations (#649 reachability map).
        ...(yieldAtInputTokens === undefined ? {} : { yieldAtInputTokens }),
        ...(steeringPending === undefined
          ? {}
          : {
              shouldYield: () => {
                if (!steeringPending()) return false;
                steering.requested = true;
                return true;
              },
            }),
        providerOptions: config.providerOptions,
        trace: { traceId: trace.traceId, sessionId: trace.sessionId, runId: trace.runId },
      },
      trackingSink,
      turnAssistant,
      turnUsage,
      stepCap,
      windowYieldArmed: yieldAtInputTokens !== undefined,
      steering,
      toolPolicyDecisions: [],
    },
  };
}

function createTrackingSink(
  state: RunState,
  sink: Sink | undefined,
  turnUsage: TokenUsage,
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
          const measured = measuredContextTokens(message);
          if (measured !== undefined) recordCallContext(state, measured);
        }
      }
      const text = message.parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text) setLastAssistantText(state, text);
      sink?.onMessage(message);
    },
    onToolCall: (call) => sink?.onToolCall(call),
    onToolResult: (result) => sink?.onToolResult(result),
    // #547 C3: the fact stream passes through untouched — the transcript
    // record family subscribes to facts, not boundary snapshots.
    onFact: (fact) => sink?.onFact?.(fact),
  };
}

export type StopOutcome = AgentResult | "continue";

/**
 * A turn whose last step still asked for tools did not finish — the llm loop
 * stopped it: at the step cap, or at the window-yield boundary the loop arms
 * from the recorded model window. Anything else is the model's own stop.
 */
function turnYield(
  turn: TurnArtifacts,
  assistantMessage: Message.WithParts,
): "window" | "steps" | "steer" | null {
  let steps = 0;
  let lastReason: string | undefined;
  for (const part of assistantMessage.parts) {
    if (part.type === "step-finish") {
      steps += 1;
      lastReason = part.reason;
    }
  }
  if (lastReason !== "tool-calls") return null;
  if (steps >= turn.stepCap) return "steps";
  // The cap outranks steering: a turn that spent its whole step budget ended
  // on the cap even if the steering check also fired — "max-steps" stays the
  // honest terminal. Steering outranks the window: the pending message should
  // reach the model next turn; a still-full window re-arms and yields again.
  if (turn.steering.requested) return "steer";
  return turn.windowYieldArmed ? "window" : "steps";
}

export async function handleStop(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  turn: TurnArtifacts,
  compaction: CompactionSession | undefined,
): Promise<StopOutcome> {
  emitTurnComplete(config.events, state, agentBase, turn.turnUsage);
  const turnText = assistantTextOf(turn.turnAssistant.message);
  const step = { type: "text" as const, content: turnText };
  appendRunStep(state, step);
  if (config.onStepFinish) await config.onStepFinish(step);
  const assistantMessage = resolveTurnAssistant(config.events, state, turn, agentBase);
  appendRunMessages(state, [assistantMessage]);
  prepareCompactionAfterContinue(state, config, compaction);

  const yielded = turnYield(turn, assistantMessage);
  if (yielded === "steer") {
    advanceRunTurn(state);
    return "continue";
  }
  if (yielded === "window") {
    const result = await applyCompaction(state, config, agentBase, compaction, "yield");
    if (result === "none" || state.lastCompactionIneffective === true) disarmWindowYield(state);
    advanceRunTurn(state);
    return "continue";
  }
  if (yielded !== "steps") {
    await applyCompaction(state, config, agentBase, compaction, "threshold");
  }
  return runResult(state, {
    finishReason: yielded === "steps" ? "max-steps" : "stop",
    text: turnText,
  });
}

/**
 * The text a turn actually produced: the text parts of its boundary snapshot,
 * empty when the turn produced none (or, on the TEST-STUB-ONLY missing-
 * snapshot path, when there is no snapshot at all — see
 * {@link resolveTurnAssistant}). Never falls back to `state.lastAssistantText`;
 * that field is the run's last produced text, kept for guard/abort results,
 * and reusing it as a turn's own output forges history (#audit M3).
 */
function assistantTextOf(message: Message.WithParts | undefined): string {
  if (message === undefined) return "";
  return message.parts
    .filter((part): part is Message.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function handleContinue(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  turnUsage: TokenUsage,
): void {
  emitTurnComplete(events, state, agentBase, turnUsage);
  advanceRunTurn(state);
}

type ErrorRetryPolicy = Parameters<typeof Retry.shouldRetry>[0];

export function handleError(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  error: Error,
  attempt: number,
  retryPolicy: ErrorRetryPolicy,
  compaction: CompactionSession | undefined,
): Promise<ErrorDecision>;
export function handleError(
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  error: Error,
  attempt: number,
  retryPolicy: ErrorRetryPolicy,
): Promise<ErrorDecision>;
export async function handleError(
  stateOrConfig: RunState | ChatAgentConfig,
  configOrAgent: ChatAgentConfig | AgentRunBase,
  agentOrError: AgentRunBase | Error,
  errorOrAttempt: Error | number,
  attemptOrPolicy: number | ErrorRetryPolicy,
  retryPolicy?: ErrorRetryPolicy,
  compaction?: CompactionSession,
): Promise<ErrorDecision> {
  const hasState = "messages" in stateOrConfig;
  const state = hasState ? stateOrConfig : undefined;
  const config = (hasState ? configOrAgent : stateOrConfig) as ChatAgentConfig;
  const agentBase = (hasState ? agentOrError : configOrAgent) as AgentRunBase;
  const error = (hasState ? errorOrAttempt : agentOrError) as Error;
  const attempt = (hasState ? attemptOrPolicy : errorOrAttempt) as number;
  const policy = (hasState ? retryPolicy : attemptOrPolicy) as ErrorRetryPolicy;

  if (Retry.isAbort(error, config.signal)) {
    return {
      action: "throw",
      error,
      failure: { reason: "aborted", attempt, maxAttempts: policy.maxAttempts },
    };
  }
  if (Retry.isContextOverflow(error)) {
    const failure = {
      reason: "context_overflow" as const,
      attempt,
      maxAttempts: policy.maxAttempts,
    };
    if (state !== undefined && state.overflowCompactionAttempted !== true) {
      state.overflowCompactionAttempted = true;
      const result = await applyCompaction(state, config, agentBase, compaction, "yield");
      if (result === "compacted") {
        emitErrorRetry(config.events, agentBase, {
          ...failure,
          error: error.message,
          backoffMs: 0,
        });
        return { action: "retry", backoffMs: 0, failure };
      }
    }
    return { action: "throw", error, failure };
  }
  const reason = Retry.classifyRetryReason(error.message);
  if (Retry.shouldRetry(policy, reason, attempt)) {
    const backoffMs = Retry.calculateBackoffMs(policy, attempt);
    emitErrorRetry(config.events, agentBase, {
      attempt,
      maxAttempts: policy.maxAttempts,
      error: error.message,
      reason,
      backoffMs,
    });
    return {
      action: "retry",
      backoffMs,
      failure: { reason, attempt, maxAttempts: policy.maxAttempts },
    };
  }
  return {
    action: "throw",
    error,
    failure: { reason, attempt, maxAttempts: policy.maxAttempts },
  };
}

type CompactionApplyResult = "compacted" | "deferred" | "none";

function resolvedCompaction(
  state: RunState,
  config: ChatAgentConfig,
): (NonNullable<ChatAgentConfig["compaction"]> & { contextWindowTokens: number }) | undefined {
  if (config.compaction === undefined) return undefined;
  const contextWindowTokens = config.compaction.contextWindowTokens ?? state.contextWindowTokens;
  if (contextWindowTokens === undefined) return undefined;
  return { ...config.compaction, contextWindowTokens };
}

export function prepareCompactionAfterContinue(
  state: RunState,
  config: ChatAgentConfig,
  compaction: CompactionSession | undefined,
): void {
  const options = resolvedCompaction(state, config);
  const measuredTokens = state.lastCallContextTokens;
  if (options === undefined || measuredTokens === undefined || compaction === undefined) return;
  const geometry = compactionGeometry(state, options);
  compaction.prepare(
    state.messages,
    measuredTokens,
    geometry.prepareTokens,
    options.contextWindowTokens,
  );
}

function compactionGeometry(
  state: RunState,
  options: NonNullable<ReturnType<typeof resolvedCompaction>>,
) {
  return resolveCompactionGeometry({
    contextWindowTokens: options.contextWindowTokens,
    ...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
    ...(state.lastCompactionYield === undefined
      ? {}
      : { previousYield: state.lastCompactionYield }),
  });
}

async function applyCompaction(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  compaction: CompactionSession | undefined,
  trigger: "threshold" | "yield",
): Promise<CompactionApplyResult> {
  const options = resolvedCompaction(state, config);
  if (options === undefined) return "none";
  const measuredTokens = state.lastCallContextTokens;
  const geometry = compactionGeometry(state, options);
  if (
    trigger === "threshold" &&
    (measuredTokens === undefined ||
      !Compaction.shouldCompact(measuredTokens, options, state.lastCompactionYield))
  ) {
    return "none";
  }
  if (
    measuredTokens !== undefined &&
    compaction?.inFlight() === true &&
    measuredTokens < geometry.graceTokens
  ) {
    state.lastCompactionDeferred = true;
    return "deferred";
  }

  state.lastCompactionDeferred = undefined;
  const candidate = compaction?.candidate();
  const result = await Compaction.compact(state.messages, options, agentBase, config.events, {
    trigger,
    ...(measuredTokens === undefined ? {} : { measuredTokens }),
    ...(candidate === undefined ? {} : { candidate }),
  });
  if (candidate !== undefined) compaction?.consume();
  state.lastCompactionIneffective = result.ineffective;
  if (result.yield !== undefined) state.lastCompactionYield = result.yield;
  if (result.summarizerFailed === true) compaction?.disable();
  if (!result.compacted) return "none";
  applyCompactionMessages(state, result.messages);
  return "compacted";
}

/**
 * The turn's assistant message is the llm fold's boundary snapshot — the one
 * source of truth for what enters history (#546). The empty-text fallback is
 * a TEST-STUB-ONLY path: every production processor exit emits a finished
 * snapshot (#557), so a missing snapshot means the configured llm run never
 * drove the sink. It is loud (Operational.Events.Error) and deliberately does NOT
 * reuse lastAssistantText, which may still hold the PREVIOUS turn's text —
 * resurrecting it would forge history.
 */
function resolveTurnAssistant(
  events: BusEvent.Sink,
  state: RunState,
  turn: TurnArtifacts,
  agentBase: AgentRunBase,
): Message.WithParts {
  if (turn.turnAssistant.message !== undefined) return turn.turnAssistant.message;
  events.publish(Operational.Events.Error, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId,
    component: "agent.turn",
    msg: "llm sink emitted no assistant snapshot — test stub?",
  });
  const parentID = state.messages.at(-1)?.info.id ?? "";
  return createAssistantMessage("", parentID, state.sessionId);
}
