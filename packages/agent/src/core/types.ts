import type { Actor, BusEvent, Model, Policy, Token, Tool } from "@openomni/protocol";
import type { Provider, RunInput, Sink } from "@openomni/llm";
import type { PolicyEngineRegistration } from "./policy/types";

export type TokenUsage = Token.AgentUsage;

export type AgentBudget = Actor.Profile.Budget;

type AgentToolSpec = Tool.Spec & {
  readonly descriptor?: Policy.Resource.Descriptor;
};

export interface ChatAgentConfig {
  /**
   * Where the run's records go. A port, not `Bus`: what sits behind it is the
   * composition root's choice, tests bind a collector, and P2 can split a
   * fail-closed ledger append from the lossy bus without touching the loop.
   */
  events: BusEvent.Sink;
  systemPrompt?: string;
  tools?: AgentToolSpec[];
  model: Model.Ref;
  /**
   * Ordered fallback models AFTER `model` (#752). On a chain-advancing
   * failure (timeout / transient_error / validation_error) the next retry
   * attempt resolves the next candidate via the pure `@openomni/placement`
   * fold. Tool errors, context overflow (the compaction recovery retries the
   * SAME model), and aborts never advance the chain; when the chain is spent
   * the last candidate absorbs the remaining attempts — WHEN the run stops
   * retrying stays the retry policy's decision. Configuring a chain also
   * makes `validation_error` retryable (it is terminal without one: a
   * refusal/unusable shape only earns a retry when a DIFFERENT model can
   * answer it). Absent = every attempt uses `model`.
   */
  modelFallbacks?: Model.Ref[];
  budget?: AgentBudget;
  onStepFinish?: (step: AgentStep) => void | Promise<void>;
  toolExecutor?: (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
  auth?: RunInput["auth"];
  allowAuthFallback?: RunInput["allowAuthFallback"];
  toolChoice?: "auto" | "required" | "none";
  /**
   * Mid-turn steering port (#751): returns true while a host-side injection
   * is pending for this run. The loop checks it at step boundaries; when it
   * fires, the turn ends early so the pending message can enter history
   * through the existing `run.turn.post` continuation drain — the same seam
   * the injection queue already uses. Absent = turns never yield for
   * steering. A host that never clears its pending signal costs one model
   * step per turn until a budget bound ends the run — never an infinite loop.
   */
  steeringPending?: () => boolean;
  middleware?: PolicyEngineRegistration[];
  llm?: {
    run?: (input: RunInput, sink: Sink) => Promise<import("@openomni/llm").Run.Outcome>;
    resolveProviderModel?: (model: Model.Ref) => Promise<Provider.Model>;
  };
}

export interface ChatAgentInput {
  /**
   * Hydrated history. `partMetadata`, when present, rides onto the rebuilt
   * text part verbatim — hydration must not strip structural identity
   * (compaction anchors carry theirs here; #702/#722 review: an anchor that
   * loses its metadata across resume breaks the merge chain and stacks
   * stale renders as pseudo-user messages).
   */
  messages: Array<
    | { role: "user"; content: string; partMetadata?: Record<string, unknown>; time?: number }
    | { role: "assistant"; content: string; partMetadata?: Record<string, unknown>; time?: number }
  >;
  traceContext?: import("@openomni/protocol").TraceContext.Type;
}

export interface AgentStep {
  type: "text";
  content: string;
}

export interface AgentResult {
  text: string;
  steps: AgentStep[];
  usage: TokenUsage;
  // Every member has a producer: runResult emits stop|stalled|max-steps.
  // The phantom "tool-calls"/"handoff" members (and handoffTarget) forced
  // every consumer to handle states that could not occur (#606 audit).
  finishReason: "stop" | "max-steps" | "stalled";
  compactionCount?: number;
  guardAborted?: boolean;
}
