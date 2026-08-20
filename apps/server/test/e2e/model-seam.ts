import { ChatAgent, type ChatAgentConfig, type ChatAgentInput } from "@openomni/agent";
import type { Provider, Run, RunInput, Sink } from "@openomni/llm";
import type { Message, Model, Tool } from "@openomni/protocol";
import type { ResidentRuntimeOptions } from "@openomni/openomni";

/**
 * The swappable model at the E2E seam.
 *
 * Two implementations flip a SINGLE lever — `ResidentRuntime`'s `runAgent`
 * option — and nothing else in the composition changes:
 *
 *   - `stubModel()` injects a `runAgent` that runs the REAL `ChatAgent` loop
 *     (real middleware, real tool executor, real S6 deny-all gate) but swaps
 *     ONLY the LLM call (`ChatAgentConfig.llm.run`) for a deterministic,
 *     scripted stream. This proves the whole router→deliver→run→reply path
 *     including the tool-authority gate WITHOUT a live model.
 *
 *   - `proxyModel()` injects NOTHING (`runAgent` stays the runtime default,
 *     `defaultRunAgent` = `ChatAgent.create(config).run(input)`), so the run
 *     resolves the real `@openomni/llm` provider against an `OPENOMNI_AUTH_FILE`
 *     proxy. It becomes a live test the moment a proxy baseURL/auth is present;
 *     until then the harness SKIPS it (never a failure, never a fake pass).
 *
 * The seam is `ChatAgentConfig.llm.run`: in production `buildResidentAgentConfig`
 * leaves `llm` undefined, so the loop uses the real `@openomni/llm` run(); the
 * stub wraps `defaultRunAgent` and threads a scripted run through the SAME
 * loop, so the loop the stub exercises is byte-for-byte the production loop
 * minus the network round trip.
 */

/** A single turn's script for the stub model. */
export interface StubScript {
  /** The deterministic assistant reply text this turn returns. */
  readonly text: string;
  /**
   * Tool calls the model "makes" this turn. Each is dispatched through the
   * REAL policy-gated executor (`RunInput.toolExecutor`, i.e. the agent-core
   * hooked executor that applies the run's middleware — the S6 deny-all gate
   * included), so the captured result reflects the genuine authority verdict.
   */
  readonly toolCalls?: readonly Tool.Call[];
}

/** What the stub model observed for one turn — the prompt it "saw" and results. */
export interface LlmCapture {
  readonly system?: string;
  readonly messages: RunInput["messages"];
  readonly toolResults: Tool.Result[];
}

/** The uniform shape the harness consumes; both models satisfy it. */
export interface SeamModel {
  readonly kind: "stub" | "proxy";
  /** The AgentDef model ref this model wants the resident composed with. */
  readonly model: Model.Ref;
  /** The `ResidentRuntime.create` options — the one lever that flips. */
  residentOptions(): Pick<ResidentRuntimeOptions, "runAgent">;
}

/** The stub model plus its capture surfaces (asserted by the cases). */
export interface StubModel extends SeamModel {
  readonly kind: "stub";
  /** FIFO queue of per-turn scripts; one is consumed per resident run. */
  readonly scripts: StubScript[];
  /** The `ChatAgentInput` each run received — hydrated messages included. */
  readonly runInputs: ChatAgentInput[];
  /** What the scripted LLM saw + tool results, one entry per run. */
  readonly llmCaptures: LlmCapture[];
}

const STUB_PROVIDER_LIMIT_CONTEXT = 200_000;

function fakeProviderModel(model: Model.Ref): Provider.Model {
  // A healthy context window so the loop never arms a spurious window-yield
  // (a resolved limit of 0 would floor the yield point to 0 tokens).
  return {
    id: model.id,
    providerID: model.provider,
    name: model.id,
    limit: { context: STUB_PROVIDER_LIMIT_CONTEXT },
  };
}

/**
 * A valid assistant boundary snapshot, hand-built to the `Message.WithParts`
 * shape the agent's tracking sink folds. No `step-finish` part: `turnYield`
 * reads the last step-finish reason, and its absence means "the model's own
 * stop", so the turn ends cleanly with this text as the result.
 */
function assistantSnapshot(text: string, input: RunInput): Message.WithParts {
  const sessionID = input.trace.sessionId;
  const id = `msg-${crypto.randomUUID()}`;
  const parentID = input.messages.at(-1)?.info.id ?? "";
  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: input.model.id,
    providerID: input.model.providerID,
    agent: "default",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };
  return { info, parts: [textPart] };
}

function scriptedRun(
  script: StubScript,
  captures: LlmCapture[],
): (input: RunInput, sink: Sink) => Promise<Run.Outcome> {
  return async (input, sink) => {
    const toolResults: Tool.Result[] = [];
    for (const call of script.toolCalls ?? []) {
      // The REAL gated executor: policy pre-dispatch runs here, so an
      // evidence_only run's deny-all gate returns a typed denial result while
      // a full_access run reaches the production tool.
      const result = await input.toolExecutor?.(call, {
        signal: input.signal,
        traceContext: {
          traceId: input.trace.traceId,
          sessionId: input.trace.sessionId,
          runId: input.trace.runId,
        },
      });
      if (result !== undefined) {
        sink.onToolCall(call);
        sink.onToolResult(result);
        toolResults.push(result);
      }
    }
    captures.push({
      ...(input.system === undefined ? {} : { system: input.system }),
      messages: input.messages,
      toolResults,
    });
    sink.onMessage(assistantSnapshot(script.text, input));
    return { type: "stop" };
  };
}

/**
 * The deterministic stub model. The injected `runAgent` runs the production
 * `ChatAgent` loop with the LLM call swapped for a scripted stream — so the
 * middleware, tool executor, and S6 gate are the real ones.
 */
export function stubModel(model: Model.Ref = { provider: "stub", id: "stub-model" }): StubModel {
  const scripts: StubScript[] = [];
  const runInputs: ChatAgentInput[] = [];
  const llmCaptures: LlmCapture[] = [];

  const runAgent = async (config: ChatAgentConfig, input: ChatAgentInput) => {
    runInputs.push(input);
    const script = scripts.shift() ?? { text: "" };
    const result = await ChatAgent.create({
      ...config,
      llm: {
        resolveProviderModel: async (ref) => fakeProviderModel(ref),
        run: scriptedRun(script, llmCaptures),
      },
    }).run(input);
    return { text: result.text, finishReason: result.finishReason };
  };

  return {
    kind: "stub",
    model,
    scripts,
    runInputs,
    llmCaptures,
    residentOptions: () => ({ runAgent }),
  };
}

/** Configuration that flips the proxy model from "skip" to "live". */
export interface ProxyModelConfig {
  /** Proxy baseURL; defaults to `OPENOMNI_E2E_PROXY_URL`. */
  readonly baseURL?: string;
  /** Provider/model ids; default to the `OPENOMNI_E2E_PROXY_*` env vars. */
  readonly model?: Model.Ref;
}

export interface ProxyModel extends SeamModel {
  readonly kind: "proxy";
  /** True iff a proxy URL or a pre-provisioned auth file is available. */
  readonly configured: boolean;
  /** The resolved baseURL (if any) — for the "would run" skip message. */
  readonly baseURL?: string;
  /** Provider id whose credential the auth file must carry. */
  readonly providerId: string;
}

/**
 * The live model. Uses the runtime default `runAgent` (the real `@openomni/llm`
 * path) and reads credentials from `OPENOMNI_AUTH_FILE`. `configured` is false
 * — and the case is skipped — unless a proxy URL or an existing auth file is
 * present. When a baseURL is given but no auth file exists, the harness writes
 * a proxy auth file and points `OPENOMNI_AUTH_FILE` at it (see harness).
 */
export function proxyModel(config: ProxyModelConfig = {}): ProxyModel {
  const baseURL = config.baseURL ?? process.env.OPENOMNI_E2E_PROXY_URL;
  const providerId = config.model?.provider ?? process.env.OPENOMNI_E2E_PROXY_PROVIDER ?? "openai";
  const modelId = config.model?.id ?? process.env.OPENOMNI_E2E_PROXY_MODEL ?? "gpt-4o-mini";
  const configured = Boolean(baseURL) || Boolean(process.env.OPENOMNI_AUTH_FILE);
  return {
    kind: "proxy",
    configured,
    ...(baseURL === undefined ? {} : { baseURL }),
    providerId,
    model: { provider: providerId, id: modelId },
    // No injection: the resident runtime's default runAgent is the real path.
    residentOptions: () => ({}),
  };
}
