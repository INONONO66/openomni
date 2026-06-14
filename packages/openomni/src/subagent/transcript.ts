import {
  ChatAgent,
  InMemoryCompactor,
  type ChatAgentConfig,
  type PolicyRegistration,
} from "@openomni/agent";
import type { Policy } from "@openomni/protocol";
import type { RuntimeModel, RuntimeMessage } from "./shared";
import {
  buildRuntimeMessages,
  buildSessionMessagesWithParts,
  estimateRuntimeTokens,
} from "./message-builder";

export type RuntimeConfig = {
  model: RuntimeModel;
  auth?: ChatAgentConfig["auth"];
  allowAuthFallback?: ChatAgentConfig["allowAuthFallback"];
  systemPrompt?: string;
  tools?: ChatAgentConfig["tools"];
  toolExecutor?: ChatAgentConfig["toolExecutor"];
  budget?: ChatAgentConfig["budget"];
  /** Parent-scoped delegation/admission middleware; never reused for child runs. */
  middleware?: PolicyRegistration[];
  /** Child-run middleware assembled from explicit child context only. */
  childMiddleware?: PolicyRegistration[];
  /** Effective child authority exposed to parent-scoped delegation admission only. */
  admissionPermissions?: Policy.Permission;
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
  messages = buildChildMessagesInternal(sessionId),
): Promise<Awaited<ReturnType<ReturnType<typeof ChatAgent.create>["run"]>>> {
  const agent = ChatAgent.create({
    model: config.model,
    auth: config.auth,
    allowAuthFallback: config.allowAuthFallback,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    budget: config.budget,
    toolExecutor: config.toolExecutor,
    signal,
    middleware: config.middleware,
  });

  return agent.run({ messages });
}
