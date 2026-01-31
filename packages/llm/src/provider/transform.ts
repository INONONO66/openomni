import type { CoreMessage } from "ai"

export namespace ProviderTransform {
  export function sdkKey(npm: string): string | undefined {
    switch (npm) {
      case "@ai-sdk/anthropic":
      case "@ai-sdk/google-vertex/anthropic":
        return "anthropic"
      case "@ai-sdk/openai":
      case "@ai-sdk/azure":
        return "openai"
      case "@ai-sdk/google-vertex":
      case "@ai-sdk/google":
        return "google"
      case "@openrouter/ai-sdk-provider":
        return "openrouter"
      default:
        return undefined
    }
  }

  export interface NormalizeOptions {
    npm: string
    modelId: string
  }

  export function normalizeMessages(
    msgs: CoreMessage[],
    model: NormalizeOptions,
    _options: Record<string, unknown> = {},
  ): CoreMessage[] {
    const key = sdkKey(model.npm)

    if (key === "anthropic") {
      return normalizeAnthropic(msgs, model)
    }

    return msgs
  }

  function normalizeAnthropic(msgs: CoreMessage[], model: NormalizeOptions): CoreMessage[] {
    let result = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg

        const filtered = msg.content.filter((part: any) => {
          if (part.type === "text" || part.type === "reasoning") {
            return (part as { text: string }).text !== ""
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is CoreMessage => msg !== undefined && msg.content !== "")

    if (model.modelId.includes("claude")) {
      result = result.map((msg) => {
        if (
          (msg.role === "assistant" || msg.role === "tool") &&
          Array.isArray(msg.content)
        ) {
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
                }
              }
              return part
            }),
          }
        }
        return msg
      })
    }

    return result
  }
}
