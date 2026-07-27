import { type ModelsDev, Provider } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import type { ChatAgentInput, ModelCatalogService } from "../types";
import { createUserMessage, createAssistantMessage } from "../message-factory";

export async function resolveProviderModel(
  model: { provider: string; id: string },
  catalog: ModelCatalogService,
): Promise<Provider.Model> {
  const data = await catalog.get();
  const providerData = data[model.provider];

  if (!providerData) {
    throw new Error(`Provider not found: ${model.provider}`);
  }

  const rawModel = providerData.models?.[model.id];
  if (!rawModel) {
    throw new Error(`Model not found: ${model.id} for provider ${model.provider}`);
  }

  return Provider.fromModelsDevModel(providerData, rawModel as ModelsDev.Model);
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
