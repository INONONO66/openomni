import { Session } from "@openomni/session";
import { ChatAgent } from "@openomni/agent";
import type { ChatAgentConfig, AgentResult } from "@openomni/agent";
import type { Message, Adapter, Tool } from "@openomni/protocol";
import { sessionCache } from "../cache/session-cache";
import { SurfaceStore } from "./surface-store";
import { getAgentDefinition } from "../agents/registry";
import type { AgentDefinition } from "../agents/types";
import { createToolExecutor } from "../tool/executor";
import type { ToolProvider } from "../tool/types";
import type { SystemToolProvider } from "../tool/system";
import type { AgentToolProvider } from "../tool/agent";
import type { McpToolProvider } from "../tool/mcp";

export interface ConversationConfig {
  agentName: string;
  systemProvider: SystemToolProvider;
  agentProvider: AgentToolProvider;
  mcpProvider: McpToolProvider;
  defaultModel?: { provider: string; id: string };
}

export function createMessageHandler(config: ConversationConfig): Adapter.MessageHandler {
  const queues = new Map<string, Promise<unknown>>();

  return async (message) => {
    // TODO: respect Adapter.Config.deliveryPolicy - currently always delivers final response only
    const resumeId = (message as { _resumeMessageId?: string })._resumeMessageId;
    const prev = queues.get(message.surfaceKey) ?? Promise.resolve();
    const current = prev.then(() =>
      processMessage(
        message.surfaceKey,
        message.text,
        config,
        resumeId ? { existingMessageId: resumeId } : undefined,
      ),
    );
    const tail = current.catch(() => undefined);
    queues.set(message.surfaceKey, tail);

    tail.then(() => {
      if (queues.get(message.surfaceKey) === tail) queues.delete(message.surfaceKey);
    });

    const text = await current;
    return text ? { text } : null;
  };
}

function buildToolsForAgent(
  definition: AgentDefinition,
  systemProvider: ToolProvider,
  agentProvider: ToolProvider,
  mcpProvider: ToolProvider,
): { specs: Tool.Spec[]; providers: ToolProvider[] } {
  const providers: ToolProvider[] = [];
  const specs: Tool.Spec[] = [];

  function addFromProvider(provider: ToolProvider, selection: boolean | string[] | undefined) {
    if (!selection) return;
    providers.push(provider);
    const tools = provider.listTools();
    if (selection === true) {
      specs.push(...tools.map((t) => t.spec));
    } else {
      const allowed = new Set(selection);
      specs.push(...tools.filter((t) => allowed.has(t.spec.name)).map((t) => t.spec));
    }
  }

  addFromProvider(systemProvider, definition.tools.system);
  addFromProvider(agentProvider, definition.tools.agent);
  addFromProvider(mcpProvider, definition.tools.mcp);

  return { specs, providers };
}

function toChatInput(
  history: Message.WithParts[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return history.map((msg) => ({
    role: msg.info.role === "user" ? ("user" as const) : ("assistant" as const),
    content: msg.parts
      .filter((p): p is Message.TextPart => p.type === "text")
      .map((p) => p.text)
      .join(""),
  }));
}

function createFallbackDefinition(config: ConversationConfig): AgentDefinition {
  return {
    name: config.agentName,
    description: "fallback agent",
    model: config.defaultModel ?? { provider: "anthropic", id: "claude-3-haiku-20240307" },
    systemPrompt: "You are a helpful assistant.",
    tools: { system: false, agent: false, mcp: false },
    budget: { maxTurns: 10 },
  };
}

function createUserMessage(
  sessionID: string,
  model: ChatAgentConfig["model"],
  text: string,
): Message.WithParts {
  const messageID = `msg-${crypto.randomUUID()}`;

  return {
    info: {
      id: messageID,
      sessionID,
      role: "user" as const,
      time: { created: Date.now() },
      agent: "serve",
      model: { providerID: model.provider, modelID: model.id },
    },
    parts: [
      {
        id: `part-${crypto.randomUUID()}`,
        sessionID,
        messageID,
        type: "text" as const,
        text,
      },
    ],
  };
}

function loadHistory(sessionID: string): Message.WithParts[] {
  const messages = Session.getMessages(sessionID);
  return messages.map((info) => ({
    info,
    parts: Session.getParts(info.id),
  }));
}

function buildAssistantMessage(
  sessionID: string,
  parentMessageID: string,
  definition: AgentDefinition,
  result: AgentResult,
): Message.WithParts {
  const messageID = `msg-${crypto.randomUUID()}`;
  const now = Date.now();

  const info: Message.AssistantMessage = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: now, completed: now },
    parentID: parentMessageID,
    modelID: definition.model.id,
    providerID: definition.model.provider,
    agent: definition.name,
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: result.usage.totalCost ?? 0,
    tokens: {
      input: result.usage.inputTokens,
      output: result.usage.outputTokens,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    finish: result.finishReason,
  };

  const parts: Message.Part[] = [];
  if (result.text) {
    parts.push({
      id: `part-${crypto.randomUUID()}`,
      sessionID,
      messageID,
      type: "text" as const,
      text: result.text,
    });
  }

  return { info, parts };
}

async function processMessage(
  surfaceKey: string,
  text: string,
  config: ConversationConfig,
  options?: { existingMessageId?: string },
): Promise<string> {
  const definition = getAgentDefinition(config.agentName) ?? createFallbackDefinition(config);

  let sessionId = SurfaceStore.lookup(surfaceKey);
  if (!sessionId) {
    const session = Session.create({
      title: surfaceKey,
      model: { providerID: definition.model.provider, modelID: definition.model.id },
    });
    sessionId = session.id;
    SurfaceStore.register(surfaceKey, sessionId);
  }
  sessionCache.touch(sessionId);

  // Persist user message before agent call (crash safety)
  let userMessageId: string;
  if (options?.existingMessageId) {
    userMessageId = options.existingMessageId;
  } else {
    const userMessage = createUserMessage(sessionId, definition.model, text);
    Session.addMessage(sessionId, userMessage.info, { status: "received" });
    for (const part of userMessage.parts) {
      Session.addPart(userMessage.info.id, part);
    }
    userMessageId = userMessage.info.id;
  }

  const history = loadHistory(sessionId);

  const { specs, providers } = buildToolsForAgent(
    definition,
    config.systemProvider,
    config.agentProvider,
    config.mcpProvider,
  );
  const toolExecutor = createToolExecutor({
    providers,
    config: { permissions: definition.permissions },
  });

  Session.updateMessageStatus(userMessageId, "processing");

  const agent = ChatAgent.create({
    model: definition.model,
    systemPrompt: definition.systemPrompt,
    tools: specs,
    toolExecutor,
    budget: definition.budget,
  });

  let result: AgentResult;
  try {
    result = await agent.run({ messages: toChatInput(history) });
  } catch (error) {
    Session.updateMessageStatus(userMessageId, "completed");
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[conversation] agent error: ${msg}`);
    return `Error: ${msg}`;
  }

  const assistantMessage = buildAssistantMessage(sessionId, userMessageId, definition, result);
  Session.addMessage(sessionId, assistantMessage.info);
  for (const part of assistantMessage.parts) {
    Session.addPart(assistantMessage.info.id, part);
  }

  Session.updateMessageStatus(userMessageId, "completed");

  return result.text || "(no response)";
}
