import { ForeignFailure, type CompactionOptions } from "@openomni/agent";
import type { RunInput } from "@openomni/llm";
import { Effect, Either } from "effect";
import type { Message, PlainObject } from "@openomni/protocol";
import { runResolvedText, type LlmIo } from "../composition/completion";

export type SummarizerErrorKind = "empty" | "overflow";

export class SummarizerError extends ForeignFailure {
  readonly kind: SummarizerErrorKind;

  constructor(kind: SummarizerErrorKind, message: string) {
    super({ operation: `compaction.${kind}`, cause: message });
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

function reasoningOptions(provider: string): PlainObject {
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
      parts: [
        { id: crypto.randomUUID(), sessionID: "compaction", messageID: id, type: "text", text },
      ],
    },
    ...input,
  ];
}

function nonemptySummary(answer: string) {
  return answer.trim().length === 0
    ? Effect.fail(new SummarizerError("empty", "compaction summarizer returned empty text"))
    : Effect.succeed(answer);
}

export function createCompactionSummarizer(
  config: SummarizerConfig,
): NonNullable<CompactionOptions["onSummarize"]> {
  return (messages, previousAnchor, budget, signal) => Effect.gen(function* () {
    const anchor = previousAnchor ?? "(none)";
    const prompt = `${INSTRUCTION}\n\nPrevious anchor:\n${anchor}`;
    let working = messages;
    for (let attempt = 0; ; attempt += 1) {
      const answer = yield* Effect.either(runResolvedText(
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
        ));
      if (Either.isRight(answer)) return yield* nonemptySummary(answer.right);
      const error = answer.left;
      if (error._tag !== "LlmRunFailure" || !error.contextOverflow) return yield* Effect.fail(error);
      if (attempt >= 2)
        return yield* new SummarizerError("overflow", "compaction summarizer context overflow");
      working = working.slice(1);
    }
  });
}
