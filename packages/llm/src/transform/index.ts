import type { SDKMessage } from "../session/convert";
import type { Provider } from "../provider/index";

export namespace ProviderTransform {
  export function sdkKey(npm: string): string | undefined {
    switch (npm) {
      case "@ai-sdk/anthropic":
      case "@ai-sdk/google-vertex/anthropic":
        return "anthropic";
      case "@ai-sdk/openai":
      case "@ai-sdk/azure":
        return "openai";
      case "@ai-sdk/google-vertex":
      case "@ai-sdk/google":
        return "google";
      case "@openrouter/ai-sdk-provider":
        return "openrouter";
      default:
        return undefined;
    }
  }

  export interface NormalizeOptions {
    npm: string;
    modelId: string;
  }

  export function normalizeMessages(
    msgs: SDKMessage[],
    model: Provider.Model | NormalizeOptions,
    _options: Record<string, unknown> = {},
  ): SDKMessage[] {
    let npm: string | undefined;
    let modelId: string;

    if ("api" in model && model.api) {
      npm = model.api.npm;
      modelId = model.id;
    } else {
      npm = (model as NormalizeOptions).npm;
      modelId = (model as NormalizeOptions).modelId;
    }

    const key = sdkKey(npm || "");

    if (key === "anthropic") {
      return normalizeAnthropic(msgs, { npm: npm || "", modelId });
    }

    return msgs;
  }

  export function temperature(model: Provider.Model): number | undefined {
    const id = model.id.toLowerCase();
    if (id.includes("claude")) return undefined;
    return undefined;
  }

  export function topP(model: Provider.Model): number | undefined {
    const id = model.id.toLowerCase();
    return undefined;
  }

  export function variants(model: Provider.Model): Record<string, Record<string, any>> {
    if (!model.capabilities?.reasoning) return {};

    const npm = model.api?.npm;
    const id = model.id.toLowerCase();

    // For anthropic models
    if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic") {
      return {
        high: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(16_000, Math.floor((model.limit?.output ?? 0) / 2 - 1)),
          },
        },
        max: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(31_999, (model.limit?.output ?? 0) - 1),
          },
        },
      };
    }

    // For OpenAI models
    if (npm === "@ai-sdk/openai") {
      return {
        low: {
          reasoningEffort: "low",
          reasoningSummary: "auto",
        },
        medium: {
          reasoningEffort: "medium",
          reasoningSummary: "auto",
        },
        high: {
          reasoningEffort: "high",
          reasoningSummary: "auto",
        },
      };
    }

    return {};
  }

  function normalizeAnthropic(msgs: SDKMessage[], model: NormalizeOptions): SDKMessage[] {
    let result = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined;
          return msg;
        }
        if (!Array.isArray(msg.content)) return msg;

        const filtered = msg.content.filter((part: any) => {
          if (part.type === "text" || part.type === "reasoning") {
            return (part as { text: string }).text !== "";
          }
          return true;
        });
        if (filtered.length === 0) return undefined;
        return { ...msg, content: filtered };
      })
      .filter((msg): msg is SDKMessage => msg !== undefined && msg.content !== "");

    if (model.modelId.includes("claude")) {
      result = result.map((msg) => {
        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map((part: any) => {
              if (
                (part.type === "tool-call" || part.type === "tool-result") &&
                "toolCallId" in part
              ) {
                return {
                  ...part,
                  toolCallId: (part as { toolCallId: string }).toolCallId.replace(
                    /[^a-zA-Z0-9_-]/g,
                    "_",
                  ),
                };
              }
              return part;
            }),
          } as unknown as SDKMessage;
        }
        return msg;
      });
    }

    return applyAnthropicCaching(result);
  }

  /** Inject ephemeral cacheControl on system msgs and last 2 user/assistant msgs. */
  export function applyAnthropicCaching(msgs: SDKMessage[]): SDKMessage[] {
    if (msgs.length === 0) return msgs;

    const targets = new Set<number>();
    let found = 0;
    for (let i = msgs.length - 1; i >= 0 && found < 2; i--) {
      const role = msgs[i].role;
      if (role === "user" || role === "assistant") {
        targets.add(i);
        found++;
      }
    }

    return msgs.map((msg, i) => {
      if (msg.role === "system" || targets.has(i)) {
        const existing = (msg as Record<string, unknown>).providerOptions as
          | Record<string, unknown>
          | undefined;
        const existingAnthropic = (existing?.anthropic ?? {}) as Record<string, unknown>;
        return {
          ...msg,
          providerOptions: {
            ...existing,
            anthropic: { ...existingAnthropic, cacheControl: { type: "ephemeral" as const } },
          },
        } as unknown as SDKMessage;
      }
      return msg;
    });
  }
}
