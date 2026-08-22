import type { Message } from "@openomni/protocol";
import type { Provider } from "../../src/provider";

export const anthropicModel: Provider.Model = {
  id: "claude-3-5-sonnet",
  providerID: "anthropic",
  name: "Claude 3.5 Sonnet",
  api: { npm: "@ai-sdk/anthropic" },
};

export function assistantMessage(
  id: string,
  sessionID: string,
  parentID = `parent-${id}`,
): Message.AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: anthropicModel.id,
    providerID: anthropicModel.providerID,
    agent: "test-agent",
    path: { cwd: "/test", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}
