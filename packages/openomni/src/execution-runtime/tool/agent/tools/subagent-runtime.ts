import { ChatAgent } from "@openomni/agent";
import type { SubagentToolOptions } from "@openomni/agent";

type SubagentRuntime = SubagentToolOptions["subagentRuntime"];

export function createSubagentRuntime(): SubagentRuntime {
  return {
    async spawn(config) {
      const agent = ChatAgent.create({
        model: config.model,
        systemPrompt: config.systemPrompt,
        middleware: config.middleware,
      });
      const result = await agent.run({
        messages: [{ role: "user", content: config.prompt }],
      });
      return {
        sessionId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        output: result.text,
      };
    },
    async send(config) {
      // stateless for now — create a fresh agent per send (session persistence is future work)
      const agent = ChatAgent.create({
        model: config.model,
        systemPrompt: config.systemPrompt,
        middleware: config.middleware,
      });
      const result = await agent.run({
        messages: [{ role: "user", content: config.prompt }],
      });
      return {
        sessionId: config.sessionId,
        runId: crypto.randomUUID(),
        output: result.text,
      };
    },
  };
}
