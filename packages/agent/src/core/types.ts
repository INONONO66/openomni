import type {
  Actor,
  BusEvent,
  LedgerAction,
  Model,
  PlainValue,
  Policy,
  Token,
  Tool,
} from "@openomni/protocol";
import type { Provider, RunInput, Sink } from "@openomni/llm";
import type { Placement } from "@openomni/placement";
import type { CompactionOptions } from "../compaction";
import type { Executor } from "../executor";

export type TokenUsage = Token.AgentUsage;

export type AgentBudget = Actor.Profile.Budget;

export interface AgentExecutionLifecycle {
  runAttempt<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    request: {
      readonly op: string;
      readonly intent: PlainValue;
      readonly effect: PlainValue;
    },
    body: () => Promise<T>,
  ): Promise<T>;
}

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
  /** The session owns inbox claims; this loop invokes its three model-step boundaries. */
  boundary?: import("../session-handle").SessionRunnerInput["boundary"];
  toolWave?: (calls: readonly Tool.Call[], signal?: AbortSignal) => Promise<readonly Tool.Result[]>;
  /** Durable L2 authority for session-owned prompt, turn, model, and tool work. */
  executor?: Executor;
  systemPrompt?: string;
  /** Durable child-action recorder, supplied only by the session composition. */
  execution?: AgentExecutionLifecycle;
  /** Direct, run-scoped history compaction strategy. */
  compaction?: CompactionOptions;
  tools?: AgentToolSpec[];
  /**
   * The brain host and any attached machines that may execute catalog tools,
   * with machine capabilities already reduced by
   * `Machine.effectiveCapabilities`. Absent honestly means one host candidate
   * with no declared capabilities and no attached machines: free/host tools
   * with empty requirements remain offerable, machine tools do not.
   */
  toolTargets?: readonly Placement.ToolTarget[];
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
  /**
   * Provider-SDK options, forwarded verbatim to the llm call. Untyped on
   * purpose: the shape is the PROVIDER's, it differs per provider and per SDK
   * version, and no Zod schema in this repo describes it. Validation is the
   * host's — whoever reads the operator's config owns rejecting a bad value;
   * neither this loop nor the llm package inspects it.
   */
  providerOptions?: Record<string, unknown>;
  auth?: RunInput["auth"];
  /**
   * Operator-supplied provider endpoint and headers, resolved by the host and
   * forwarded verbatim to every llm call this run makes. The loop never reads
   * it — it only carries it, the same way it carries `auth`.
   */
  transport?: RunInput["transport"];
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
    | {
        role: "user";
        content: string;
        id?: string;
        partMetadata?: Record<string, unknown>;
        time?: number;
      }
    | {
        role: "assistant";
        content: string;
        id?: string;
        partMetadata?: Record<string, unknown>;
        time?: number;
      }
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
