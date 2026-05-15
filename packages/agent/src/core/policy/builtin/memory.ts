import type { Memory } from "../../memory";
import type { PolicyFactory, PolicyRegistration } from "../types";
import type { Message } from "@openomni/protocol";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/session";

function getLastUserText(messages: Message.WithParts[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.info.role === "user") {
      return message.parts
        .filter((p): p is Message.TextPart => p.type === "text")
        .map((p) => p.text)
        .join("");
    }
  }
  return null;
}

export function createMemoryPolicy(memory: Memory): PolicyRegistration {
  return {
    name: "builtin:memory",
    timing: "context.prepare",
    priority: 100,
    fn: async (ctx) => {
      const text = getLastUserText(ctx.messages);
      if (!text) return PolicyDecision.allow({ policyId: "builtin.memory" });
      let results: Awaited<ReturnType<Memory["retrieve"]>>;
      try {
        results = await memory.retrieve(text);
      } catch (error) {
        Bus.publish(Operational.Debug, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "builtin:memory",
          msg: "memory retrieval failed",
          context: { error },
        });
        return PolicyDecision.allow({ policyId: "builtin.memory" });
      }
      if (!results || results.length === 0)
        return PolicyDecision.allow({ policyId: "builtin.memory" });
      const entries = results.map((r) => `- ${r.content}`).join("\n");
      return PolicyDecision.allow({
        policyId: "builtin.memory",
        reasonCodes: ["memory_context_available"],
        effects: [{ type: "prompt.append_context", context: `[Memory Context]\n${entries}` }],
      });
    },
  };
}

export const memoryFactory: PolicyFactory = {
  id: "policy:memory",
  create: (_config, runtime) => createMemoryPolicy(runtime.memory as Memory),
};
