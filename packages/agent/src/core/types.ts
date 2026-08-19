import type { Actor, BusEvent, Model, Policy, Token, Tool } from "@openomni/protocol";
import type { Provider, RunInput, Sink } from "@openomni/llm";
import type { PolicyEngineRegistration } from "./policy/types";

export interface TokenUsage extends Token.AgentUsage {}

export interface AgentBudget extends Actor.Profile.Budget {}

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
  budget?: AgentBudget;
  onStepFinish?: (step: AgentStep) => void | Promise<void>;
  toolExecutor?: (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
  auth?: RunInput["auth"];
  allowAuthFallback?: RunInput["allowAuthFallback"];
  toolChoice?: "auto" | "required" | "none";
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
