import type { ChatAgentConfig } from "@openomni/agent";

export interface ChatProviderOptions {
  readonly apiKey: string;
  readonly transport?: ChatAgentConfig["transport"];
  readonly llm?: ChatAgentConfig["llm"];
}

export function chatProviderConfig(
  options: ChatProviderOptions,
): Pick<ChatAgentConfig, "auth" | "transport" | "llm"> {
  return {
    auth: { type: "api", key: options.apiKey },
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  };
}
