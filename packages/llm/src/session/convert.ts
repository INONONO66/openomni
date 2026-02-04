import type { CoreMessage } from "ai";
import { Message } from "./message";
import { Provider, ProviderTransform } from "../provider";

export function toModelMessages(
  messages: Message.Info[],
  model: Provider.Model,
): CoreMessage[] {
  const coreMessages: CoreMessage[] = messages.map((msg) => {
    if (msg.role === "user") {
      return {
        role: "user",
        content: "",
      };
    } else {
      return {
        role: "assistant",
        content: "",
      };
    }
  });

  return ProviderTransform.normalizeMessages(coreMessages, model);
}
