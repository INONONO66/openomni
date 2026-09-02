import type { CompactionOptions } from "@openomni/agent";
import { Run, type RunInput } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import { runResolvedText, type LlmIo } from "../tools/execution/llm";

export type SummarizerErrorKind = "empty" | "overflow";

export class SummarizerError extends Error {
  readonly kind: SummarizerErrorKind;

  constructor(kind: SummarizerErrorKind, message: string) {
    super(message);
    this.name = "SummarizerError";
    this.kind = kind;
  }
}

interface SummarizerConfig {
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly apiKey: string;
    readonly transport?: RunInput["transport"];
  };
  readonly io?: LlmIo;
}

const INSTRUCTION =
  "Merge the previous anchor and the new conversation span into one dense summary. " +
  "Preserve decisions, open work, identifiers, file paths, and explicit Owner instructions. " +
  "Never invent or infer facts; omit anything that is not supported by the input.";

function reasoningOptions(provider: string): Record<string, unknown> {
  return provider === "anthropic"
    ? { anthropic: { thinking: { type: "disabled" } } }
    : { openai: { reasoningEffort: "minimal" } };
}

function messageWithText(input: Message.WithParts[], text: string): Message.WithParts[] {
  const id = `compaction-${crypto.randomUUID()}`;
  return [
    {
      info: {
        id,
        sessionID: "compaction",
        role: "user",
        time: { created: Date.now() },
        agent: "compaction",
        model: { providerID: "", modelID: "" },
      },
      parts: [{ id: crypto.randomUUID(), sessionID: "compaction", messageID: id, type: "text", text }],
    },
    ...input,
  ];
}

export function createCompactionSummarizer(
  config: SummarizerConfig,
): NonNullable<CompactionOptions["onSummarize"]> {
  return async (messages, previousAnchor, budget, signal) => {
    const anchor = previousAnchor ?? "(none)";
    const prompt = `${INSTRUCTION}\n\nPrevious anchor:\n${anchor}`;
    let working = messages;
    let lastError: unknown;

    for (let attempt = 0; attempt <= 2; attempt += 1) {
      try {
        const answer = await runResolvedText(
          {
            model: config.model,
            messages: messageWithText(working, prompt),
            sessionId: "compaction",
            signal,
            maxTokens: Math.min(
              32_768,
              Math.floor(budget.contextWindowTokens * 0.5),
              budget.maxOutputTokens,
            ),
            providerOptions: reasoningOptions(config.model.provider),
          },
          config.io,
        );
        if (answer.trim().length === 0) {
          throw new SummarizerError("empty", "compaction summarizer returned empty text");
        }
        return answer;
      } catch (error) {
        lastError = error;
        const contextOverflow =
          Run.FailureError.isInstance(error) && error.data.contextOverflow;
        if (contextOverflow && attempt < 2) {
          working = working.slice(1);
          continue;
        }
        if (contextOverflow) {
          throw new SummarizerError("overflow", "compaction summarizer context overflow");
        }
        throw error;
      }
    }
    throw new SummarizerError("overflow", `compaction summarizer context overflow: ${String(lastError)}`);
  };
}

