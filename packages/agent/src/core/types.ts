import type {
  AgentProfile,
  BusEvent,
  Model,
  RuntimeResource,
  Sink,
  Token,
  Tool,
} from "@openomni/protocol";
import type { Provider, RunInput } from "@openomni/llm";
import type { PolicyEngineRegistration } from "./policy/types";

export interface TokenUsage extends Token.AgentUsage {}

export interface AgentBudget extends AgentProfile.AgentBudget {}

type AgentToolSpec = Tool.Spec & {
  readonly descriptor?: RuntimeResource.Descriptor;
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
    run?: (input: RunInput, sink: Sink) => Promise<import("@openomni/protocol").Run.Outcome>;
    resolveProviderModel?: (model: Model.Ref) => Promise<Provider.Model>;
  };
}

export interface ChatAgentInput {
  messages: Array<{ role: "user"; content: string } | { role: "assistant"; content: string }>;
  metadata?: Record<string, unknown>;
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
