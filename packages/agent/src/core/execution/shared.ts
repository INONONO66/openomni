import { ModelsDev, Provider } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import type { ChatAgentInput } from "../types";
import { createUserMessage, createAssistantMessage } from "../message-factory";

export async function resolveProviderModel(model: {
  provider: string;
  id: string;
}): Promise<Provider.Model> {
  const data = await ModelsDev.get();
  const providerData = data[model.provider];

  if (!providerData) {
    throw new Error(`Provider not found: ${model.provider}`);
  }

  const rawModel = providerData.models?.[model.id];
  if (rawModel) {
    return Provider.fromModelsDevModel(providerData, rawModel as ModelsDev.Model);
  }

  const proxyModels = await Provider.listModels(model.provider, "proxy").catch(() => []);
  const match = proxyModels.find((m) => m.id === model.id);
  if (match) return match;

  throw new Error(`Model not found: ${model.id} for provider ${model.provider}`);
}

export function getLastUserMessageText(messages: Message.WithParts[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.info.role === "user") {
      return message.parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");
    }
  }
  return null;
}

export function prependContextMessage(
  messages: Message.WithParts[],
  contextText: string,
  source: string,
): Message.WithParts[] {
  return [createUserMessage(contextText, source), ...messages];
}

export function toMessagesWithParts(
  messages: ChatAgentInput["messages"],
  source: string,
): Message.WithParts[] {
  const output: Message.WithParts[] = [];

  for (const message of messages) {
    const parentID = output.at(-1)?.info.id ?? "";
    output.push(
      message.role === "user"
        ? createUserMessage(message.content, source)
        : createAssistantMessage(message.content, parentID, source),
    );
  }

  return output;
}

export function summarizeInput(input: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(input);
    return str.length > 100 ? `${str.slice(0, 97)}...` : str;
  } catch {
    return "[unserializable]";
  }
}
