import type { Memory } from "../../memory";
import type { MiddlewareRegistration } from "../types";
import type { Message } from "@openomni/protocol";
import { Log } from "@openomni/session";

function getLastUserText(messages: Message.WithParts[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") {
      return messages[i].parts
        .filter((p): p is Message.TextPart => p.type === "text")
        .map((p) => p.text)
        .join("");
    }
  }
  return null;
}

export function createMemoryMiddleware(memory: Memory): MiddlewareRegistration {
  return {
    name: "builtin:memory",
    timing: "on_system_prompt",
    priority: 100,
    fn: async (ctx) => {
      const text = getLastUserText(ctx.messages);
      if (!text) return { action: "continue" };
      let results;
      try {
        results = await memory.retrieve(text);
      } catch (error) {
        Log.debug("memory retrieval failed", { error });
        return { action: "continue" };
      }
      if (!results || results.length === 0) return { action: "continue" };
      const entries = results.map((r) => `- ${r.content}`).join("\n");
      return {
        action: "transform",
        input: { appendContext: `[Memory Context]\n${entries}` },
      };
    },
  };
}
