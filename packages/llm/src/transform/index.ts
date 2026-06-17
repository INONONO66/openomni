import { Model } from "@openomni/protocol";
import type { SDKMessage } from "../session/convert";
import type { Provider } from "../provider/index";

export namespace ProviderTransform {
  interface NormalizeOptions {
    npm: string;
    modelId: string;
  }

  type SDKMessageWithProviderOptions = SDKMessage & {
    readonly providerOptions?: Record<string, unknown>;
  };

  type AssistantMessageContent = Extract<SDKMessage, { role: "assistant" }>["content"];
  type AssistantContentPart = Exclude<AssistantMessageContent, string>[number];
  type ToolContentPart = Extract<SDKMessage, { role: "tool" }>["content"][number];
  type NormalizableContentPart = Exclude<SDKMessage["content"], string>[number];

  export function normalizeMessages(
    msgs: SDKMessage[],
    model: Provider.Model | NormalizeOptions,
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

    if (isAnthropicPackage(npm)) {
      return normalizeAnthropic(msgs, { npm: npm || "", modelId });
    }

    return msgs;
  }

  export function variants(model: Provider.Model): Record<string, Record<string, unknown>> {
    if (!model.capabilities?.reasoning) return {};

    const npm = model.api?.npm;

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

  export function resolveVariant(model: Provider.Model, variant?: string): Record<string, unknown>;
  export function resolveVariant(model: Model.Ref, variant?: string): Record<string, unknown>;
  export function resolveVariant(
    model: Provider.Model | Model.Ref,
    variant?: string,
  ): Record<string, unknown> {
    if (!variant) return {};
    if (isProviderModel(model)) {
      return variants(model)[variant] ?? {};
    }
    if (!Model.isRef(model)) return {};

    const providerName = model.provider;
    const npm =
      providerName === "anthropic"
        ? "@ai-sdk/anthropic"
        : providerName === "openai"
          ? "@ai-sdk/openai"
          : undefined;
    if (!npm) return {};
    const syntheticModel: Provider.Model = {
      id: model.id,
      providerID: model.provider,
      name: model.id,
      api: { npm },
      capabilities: { reasoning: true },
      limit: { output: 64_000 },
    };
    return variants(syntheticModel)[variant] ?? {};
  }

  function isProviderModel(model: Provider.Model | Model.Ref): model is Provider.Model {
    return "providerID" in model;
  }

  function isAnthropicPackage(npm: string | undefined): boolean {
    return npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic";
  }

  function normalizeAnthropic(msgs: SDKMessage[], model: NormalizeOptions): SDKMessage[] {
    let result = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined;
          return msg;
        }
        if (!Array.isArray(msg.content)) return msg;

        const filtered = msg.content.filter((part) => {
          if (part.type === "text" || part.type === "reasoning") {
            return part.text !== "";
          }
          return true;
        });
        if (filtered.length === 0) return undefined;
        return buildMessageWithContent(msg, filtered);
      })
      .filter((msg): msg is SDKMessage => msg !== undefined && msg.content !== "");

    if (model.modelId.includes("claude")) {
      result = result.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          return { ...msg, content: msg.content.map(sanitizeAssistantContentPart) };
        }
        if (msg.role === "tool" && Array.isArray(msg.content)) {
          return { ...msg, content: msg.content.map(sanitizeToolContentPart) };
        }
        return msg;
      });
    }

    return applyAnthropicCaching(result);
  }

  export function applyAnthropicCaching(msgs: SDKMessage[]): SDKMessage[] {
    if (msgs.length === 0) return msgs;

    const targets = new Set<number>();
    let found = 0;
    for (let i = msgs.length - 1; i >= 0 && found < 2; i--) {
      const msg = msgs[i];
      if (msg == null) {
        continue;
      }
      const role = msg.role;
      if (role === "user" || role === "assistant") {
        targets.add(i);
        found++;
      }
    }

    return msgs.map((msg, i) => {
      if (msg.role === "system" || targets.has(i)) {
        const existing = (msg as SDKMessageWithProviderOptions).providerOptions;
        const existingAnthropic = (existing?.anthropic ?? {}) as Record<string, unknown>;
        return {
          ...msg,
          providerOptions: {
            ...existing,
            anthropic: { ...existingAnthropic, cacheControl: { type: "ephemeral" as const } },
          },
        };
      }
      return msg;
    });
  }

  function sanitizeAssistantContentPart(part: AssistantContentPart): AssistantContentPart {
    if (part.type !== "tool-call") return part;
    return {
      ...part,
      toolCallId: sanitizeToolCallID(part.toolCallId),
    };
  }

  function sanitizeToolContentPart(part: ToolContentPart): ToolContentPart {
    if (part.type !== "tool-result") return part;
    return {
      ...part,
      toolCallId: sanitizeToolCallID(part.toolCallId),
    };
  }

  function sanitizeToolCallID(toolCallID: string): string {
    return toolCallID.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function buildMessageWithContent(
    msg: SDKMessage,
    content: NormalizableContentPart[],
  ): SDKMessage | undefined {
    switch (msg.role) {
      case "assistant":
        return {
          ...msg,
          content: content.filter(isAssistantContentPart),
        };
      case "tool":
        return {
          ...msg,
          content: content.filter(isToolContentPart),
        };
      case "system":
      case "user":
        return msg;
    }
  }

  function isAssistantContentPart(part: NormalizableContentPart): part is AssistantContentPart {
    return (
      part.type === "text" ||
      part.type === "file" ||
      part.type === "reasoning" ||
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request"
    );
  }

  function isToolContentPart(part: NormalizableContentPart): part is ToolContentPart {
    return part.type === "tool-result" || part.type === "tool-approval-response";
  }
}
