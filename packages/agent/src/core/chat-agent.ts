import {
  ModelsDev,
  Provider,
  run as llmRun,
  TokenTracker,
  type RunInput,
} from "@openomni/llm";
import type { Message, Sink, Tool } from "@openomni/protocol";
import type {
  ChatAgentConfig,
  ChatAgentInput,
  AgentResult,
  AgentStep,
  TokenUsage,
} from "./types";
import {
  createBudgetState,
  checkBudget,
  recordTurn,
  recordToolCall,
  recordTokenUsage,
} from "./budget";
import {
  DEFAULT_RETRY_POLICY,
  calculateBackoffMs,
  classifyRetryReason,
  shouldRetry,
  sleep,
} from "./retry";
import { ToolGuard } from "./tool-guard";
import { streamAgent } from "./execution/stream-engine";
import { ToolExecutor } from "./execution/tool-executor";
import { InMemoryCompactor } from "./execution/compaction";
import type { AgentEvent } from "./types";

/**
 * ChatAgent instance interface
 */
export interface ChatAgentInstance {
  run(input: ChatAgentInput, sink?: Sink): Promise<AgentResult>;
  stream(input: ChatAgentInput, sink?: Sink): AsyncIterable<AgentEvent>;
}

const noopSink: Sink = {
  onMessage: () => {},
  onToolCall: () => {},
  onToolResult: () => {},
  onSnapshot: () => {},
};

async function resolveProviderModel(model: {
  provider: string;
  id: string;
}): Promise<Provider.Model> {
  const data = await ModelsDev.get();
  const providerData = data[model.provider];

  if (!providerData) {
    throw new Error(`Provider not found: ${model.provider}`);
  }

  const rawModel = providerData.models?.[model.id];
  if (!rawModel) {
    throw new Error(
      `Model not found: ${model.id} for provider ${model.provider}`,
    );
  }

  return Provider.fromModelsDevModel(providerData, rawModel as ModelsDev.Model);
}

function createUserMessage(content: string): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "chat-agent";
  const now = Date.now();
  const info: Message.UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: now },
    agent: "chat-agent",
    model: { providerID: "", modelID: "" },
  };
  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text: content,
  };
  return { info, parts: [textPart] };
}

function createAssistantMessage(
  content: string,
  parentID: string,
): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "chat-agent";
  const now = Date.now();
  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: now },
    parentID,
    modelID: "",
    providerID: "",
    agent: "chat-agent",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text: content,
  };
  return { info, parts: [textPart] };
}

function toMessagesWithParts(
  messages: ChatAgentInput["messages"],
): Message.WithParts[] {
  const output: Message.WithParts[] = [];

  for (const message of messages) {
    const parentID = output.length > 0 ? output[output.length - 1].info.id : "";
    output.push(
      message.role === "user"
        ? createUserMessage(message.content)
        : createAssistantMessage(message.content, parentID),
    );
  }

  return output;
}

async function executeTools(
  calls: Tool.Call[],
  _specs: Tool.Spec[],
  config?: ChatAgentConfig,
): Promise<Tool.Result[]> {
  if (config?.toolExecutor) {
    const guard = config.permissions
      ? (toolName: string) => ToolGuard.check(toolName, config.permissions!)
      : undefined;

    return ToolExecutor.executeSequential(calls, config.toolExecutor, {
      guard,
    });
  }

  return calls.map((call) => ({
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: `Tool '${call.tool}' executed (no executor configured)`,
    isError: false,
  }));
}

function buildAssistantMessageWithTools(
  toolCalls: Tool.Call[],
  toolResults: Tool.Result[],
  parentID: string,
): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "chat-agent";
  const now = Date.now();

  const resultByCallId = new Map(
    toolResults.map((result) => [result.toolCallId, result]),
  );
  const parts: Message.ToolPart[] = toolCalls.map((call) => {
    const result = resultByCallId.get(call.id);
    const start = now;
    const end = now;

    if (result?.isError) {
      return {
        id: crypto.randomUUID(),
        sessionID,
        messageID: id,
        type: "tool",
        callID: call.id,
        tool: call.tool,
        state: {
          status: "error",
          input: call.input,
          error: result.output,
          time: { start, end },
        },
      };
    }

    return {
      id: crypto.randomUUID(),
      sessionID,
      messageID: id,
      type: "tool",
      callID: call.id,
      tool: call.tool,
      state: {
        status: "completed",
        input: call.input,
        output: result?.output ?? "",
        title: call.tool,
        metadata: {},
        time: { start, end },
      },
    };
  });

  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: now },
    parentID,
    modelID: "",
    providerID: "",
    agent: "chat-agent",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };

  return { info, parts };
}

/**
 * ChatAgent namespace — stateless agent for single-turn or multi-turn conversations
 */
export namespace ChatAgent {
  /**
   * Create a new ChatAgent instance
   */
  export function create(config: ChatAgentConfig): ChatAgentInstance {
    return {
      async run(input: ChatAgentInput, sink?: Sink): Promise<AgentResult> {
        const effectiveSink = sink ?? noopSink;
        const retryPolicy = DEFAULT_RETRY_POLICY;

        let attempt = 1;
        let lastError = "";

        while (attempt <= retryPolicy.maxAttempts) {
          try {
            const providerModel = await resolveProviderModel(config.model);
            let budgetState = createBudgetState();
            let messages = toMessagesWithParts(input.messages);
            let lastAssistantText = "";
            const steps: AgentStep[] = [];
            let compactionCount = 0;
            const totalUsage: TokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            };

            const trackingSink: Sink = {
              onMessage: (message) => {
                if (message.info.role === "assistant") {
                  const tokens = (message.info as Message.AssistantMessage)
                    .tokens;
                  totalUsage.inputTokens += tokens.input;
                  totalUsage.outputTokens += tokens.output;
                  totalUsage.totalTokens += tokens.input + tokens.output;
                  const cost = TokenTracker.calculateCost(
                    { inputTokens: tokens.input, outputTokens: tokens.output },
                    config.model.id,
                  );
                  budgetState = recordTokenUsage(
                    budgetState,
                    tokens.input,
                    tokens.output,
                    cost.totalCost,
                  );
                  totalUsage.totalCost =
                    (totalUsage.totalCost ?? 0) + cost.totalCost;
                }
                const text = message.parts
                  .filter(
                    (part): part is Message.TextPart => part.type === "text",
                  )
                  .map((part) => part.text)
                  .join("");
                if (text) {
                  lastAssistantText = text;
                }
                effectiveSink.onMessage(message);
              },
              onToolCall: effectiveSink.onToolCall,
              onToolResult: effectiveSink.onToolResult,
              onSnapshot: effectiveSink.onSnapshot,
            };

            while (true) {
              if (checkBudget(budgetState, config.budget) === "exceeded") {
                return {
                  text: lastAssistantText,
                  steps,
                  usage: totalUsage,
                  finishReason: "max-steps",
                  compactionCount:
                    compactionCount > 0 ? compactionCount : undefined,
                };
              }

              budgetState = recordTurn(budgetState);

              if (config.signal?.aborted) {
                throw new Error("aborted");
              }

              const runInput: RunInput = {
                messages,
                tools: config.tools ?? [],
                system: config.systemPrompt,
                signal: config.signal,
                model: providerModel,
              };

              const outcome = await llmRun(runInput, trackingSink);

              if (outcome.type === "stop") {
                const step: AgentStep = {
                  type: "text",
                  content: lastAssistantText,
                };
                steps.push(step);

                if (config.onStepFinish) {
                  await config.onStepFinish(step);
                }

                return {
                  text: lastAssistantText,
                  steps,
                  usage: totalUsage,
                  finishReason: "stop",
                  compactionCount:
                    compactionCount > 0 ? compactionCount : undefined,
                };
              }

              if (outcome.type === "aborted") {
                throw new Error("aborted");
              }

              if (outcome.type === "error") {
                throw new Error(outcome.error.message);
              }

              if (outcome.toolCalls.length === 0) {
                throw new Error("Tool wait requested with no tool calls");
              }

              const toolStart = Date.now();
              const toolResults = await executeTools(
                outcome.toolCalls,
                config.tools ?? [],
                config,
              );
              const elapsed = Date.now() - toolStart;
              const perToolMs =
                toolResults.length > 0
                  ? Math.max(1, Math.ceil(elapsed / toolResults.length))
                  : elapsed;

              for (const result of toolResults) {
                effectiveSink.onToolResult(result);
                budgetState = recordToolCall(budgetState, perToolMs);
              }

              const toolStep: AgentStep = {
                type: "tool-call",
                content: "",
                toolCalls: outcome.toolCalls,
                toolResults,
              };
              steps.push(toolStep);

              if (config.onStepFinish) {
                await config.onStepFinish(toolStep);
              }

              const parentID =
                messages.length > 0
                  ? messages[messages.length - 1].info.id
                  : "";
              const assistantWithTools = buildAssistantMessageWithTools(
                outcome.toolCalls,
                toolResults,
                parentID,
              );
              messages = [...messages, assistantWithTools];

              if (config.compaction) {
                const totalTokens =
                  budgetState.totalInputTokens + budgetState.totalOutputTokens;
                if (
                  InMemoryCompactor.shouldCompact(
                    totalTokens,
                    config.compaction,
                  )
                ) {
                  const result = await InMemoryCompactor.compact(
                    messages,
                    config.compaction,
                  );
                  if (result.compacted) {
                    messages = result.messages;
                    compactionCount += 1;
                  }
                }
              }
            }
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            const retryReason = classifyRetryReason(lastError);

            if (shouldRetry(retryPolicy, retryReason, attempt)) {
              const backoffMs = calculateBackoffMs(retryPolicy, attempt);
              await sleep(backoffMs);
              attempt += 1;
              continue;
            }

            throw error;
          }
        }

        throw new Error(lastError || "Max retry attempts exceeded");
      },
      async *stream(
        input: ChatAgentInput,
        sink?: Sink,
      ): AsyncIterable<AgentEvent> {
        yield* streamAgent(input, config, sink);
      },
    };
  }
}
