import { ModelsDev, Provider, run as llmRun, type RunInput } from "@openomni/llm";
import type { BusEvent, Message, Model } from "@openomni/protocol";

/**
 * The production completion for the anchored summarizer (Owner ruling
 * 2026-08-19: summarization enabled by default, iterate from live data —
 * supersedes #649's elision-only default). D7: the summary uses the run's
 * own model — a cheaper summarizer degrades every downstream turn.
 *
 * One-shot, tool-less, single-step llm call. The summary call runs under
 * the run's own trace with a suffixed runId, so its cost and telemetry are
 * attributable to the run that paid for it while staying distinguishable
 * from the conversation's own calls.
 */
export interface AnchorCompletionDeps {
  readonly model: Model.Ref;
  readonly auth?: RunInput["auth"];
  readonly allowAuthFallback?: boolean;
  readonly trace: { readonly traceId: string; readonly sessionId: string; readonly runId: string };
  readonly events: BusEvent.Sink;
  readonly resolveProviderModel?: (model: Model.Ref) => Promise<Provider.Model>;
  /** Injectable for tests; production uses the real llm run. */
  readonly runFn?: typeof llmRun;
}

async function defaultResolveProviderModel(model: Model.Ref): Promise<Provider.Model> {
  const data = await ModelsDev.get();
  const providerData = data[model.provider];
  if (!providerData) {
    throw new Error(`anchor completion: provider not found: ${model.provider}`);
  }
  const rawModel = providerData.models?.[model.id];
  if (!rawModel) {
    throw new Error(`anchor completion: model not found: ${model.provider}/${model.id}`);
  }
  return Provider.fromModelsDevModel(providerData, rawModel as ModelsDev.Model);
}

export function createAnchorCompletion(
  deps: AnchorCompletionDeps,
): (prompt: string) => Promise<string> {
  let resolved: Promise<Provider.Model> | undefined;
  return async (prompt: string): Promise<string> => {
    resolved ??= (deps.resolveProviderModel ?? defaultResolveProviderModel)(deps.model);
    const providerModel = await resolved;

    const messageId = crypto.randomUUID();
    const message: Message.WithParts = {
      info: {
        id: messageId,
        sessionID: deps.trace.sessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "compaction-summary",
        model: { providerID: deps.model.provider, modelID: deps.model.id },
      },
      parts: [
        {
          id: crypto.randomUUID(),
          sessionID: deps.trace.sessionId,
          messageID: messageId,
          type: "text",
          text: prompt,
        },
      ],
    };

    let text = "";
    const outcome = await (deps.runFn ?? llmRun)(
      {
        messages: [message],
        tools: [],
        model: providerModel,
        ...(deps.auth === undefined ? {} : { auth: deps.auth }),
        ...(deps.allowAuthFallback === undefined
          ? {}
          : { allowAuthFallback: deps.allowAuthFallback }),
        maxSteps: 1,
        trace: { ...deps.trace, runId: `${deps.trace.runId}:anchor-summary` },
        events: deps.events,
      },
      {
        onMessage: (assistant) => {
          text = assistant.parts
            .filter((part): part is Message.TextPart => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        },
        onToolCall: () => undefined,
        onToolResult: () => undefined,
      },
    );
    if (outcome.type === "error") {
      throw new Error(`anchor summary failed: ${outcome.error.message}`);
    }
    return text;
  };
}
