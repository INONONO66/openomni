import { ChatAgent, InMemoryCompactor, type ChatAgentConfig } from "@openomni/agent";
import type { Guardrail } from "@openomni/protocol";
import type { RuntimeModel, RuntimeMessage } from "./shared";
import {
  buildRuntimeMessages,
  buildSessionMessagesWithParts,
  estimateRuntimeTokens,
} from "./message-builder";

export type RuntimeConfig = {
  model: RuntimeModel;
  systemPrompt?: string;
  tools?: ChatAgentConfig["tools"];
  toolExecutor?: ChatAgentConfig["toolExecutor"];
  budget?: ChatAgentConfig["budget"];
};

export type SendCompactionConfig = {
  contextWindowTokens: number;
  thresholdRatio?: number;
  onSummarize?: (messages: RuntimeMessage[]) => Promise<string>;
};

export function buildChildMessagesInternal(sessionId: string, repair?: boolean): RuntimeMessage[] {
  return buildRuntimeMessages(buildSessionMessagesWithParts(sessionId), repair);
}

export async function maybeCompactSendTranscript(
  sessionId: string,
  messages: RuntimeMessage[],
  compaction?: SendCompactionConfig,
): Promise<RuntimeMessage[]> {
  if (!compaction) {
    return messages;
  }

  const totalTokens = estimateRuntimeTokens(messages);
  if (
    !InMemoryCompactor.shouldCompact(totalTokens, {
      contextWindowTokens: compaction.contextWindowTokens,
      thresholdRatio: compaction.thresholdRatio,
    })
  ) {
    return messages;
  }

  const anchor = messages.find((message) => message.role === "user")?.content;
  const result = await InMemoryCompactor.compact(buildSessionMessagesWithParts(sessionId), {
    contextWindowTokens: compaction.contextWindowTokens,
    thresholdRatio: compaction.thresholdRatio,
    onSummarize: compaction.onSummarize
      ? async (messagesToSummarize) =>
          compaction.onSummarize?.(buildRuntimeMessages(messagesToSummarize)) ?? ""
      : undefined,
  });

  if (!result.compacted) {
    return messages;
  }

  const compactedMessages = buildRuntimeMessages(result.messages);
  if (!anchor) {
    return compactedMessages;
  }

  return [{ role: "user", content: `Original goal: ${anchor}` }, ...compactedMessages];
}

export async function runWithTranscript(
  sessionId: string,
  config: RuntimeConfig,
  signal?: AbortSignal,
  permissions?: Guardrail.Permission,
  messages = buildChildMessagesInternal(sessionId),
): Promise<Awaited<ReturnType<ReturnType<typeof ChatAgent.create>["run"]>>> {
  const agent = ChatAgent.create({
    model: config.model,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    budget: config.budget,
    toolExecutor: config.toolExecutor,
    signal,
    permissions,
  });

  return agent.run({ messages });
}
