import { run as llmRun, type RunInput } from "@openomni/llm";
import type { Message, Sink, Tool } from "@openomni/protocol";
import type { ChatAgentConfig, ChatAgentInput, AgentResult, AgentStep, TokenUsage } from "./types";
import { createBudgetState, checkBudget, recordTurn, recordTokenUsage } from "./budget";
import {
  DEFAULT_RETRY_POLICY,
  calculateBackoffMs,
  classifyRetryReason,
  shouldRetry,
  sleep,
} from "./retry";
import { streamAgent } from "./execution/stream-engine";
import { MiddlewareEngine, fromConfig } from "./middleware";
import {
  createBudgetReassuranceMiddleware,
  createBudgetWarningMiddleware,
  createCompactionMiddleware,
} from "./middleware/builtin";
import type { AgentEvent } from "./types";
import { Telemetry } from "./telemetry";
import { createAssistantMessage, createUserMessage } from "./message-factory";
import { buildSystemPrompt } from "./prompt-builder";
import {
  resolveProviderModel,
  getLastUserMessageText,
  formatMemoryContext,
  prependContextMessage,
  toMessagesWithParts,
} from "./execution/shared";
import { createToolExecutor } from "./execution/tool-executor";

export interface ChatAgentInstance {
  run(input: ChatAgentInput, sink?: Sink): Promise<AgentResult>;
  stream(input: ChatAgentInput, sink?: Sink): AsyncIterable<AgentEvent>;
}

const noopSink: Sink = {
  onMessage: () => undefined,
  onToolCall: () => undefined,
  onToolResult: () => undefined,
  onSnapshot: () => undefined,
};

export namespace ChatAgent {
  export function create(config: ChatAgentConfig): ChatAgentInstance {
    return {
      async run(input: ChatAgentInput, sink?: Sink): Promise<AgentResult> {
        return Telemetry.span(
          "ChatAgent.run",
          async (_span) => {
            const effectiveSink = sink ?? noopSink;
            const retryPolicy = DEFAULT_RETRY_POLICY;

            let attempt = 1;
            let lastError = "";

            while (attempt <= retryPolicy.maxAttempts) {
              try {
                const providerModel = await resolveProviderModel(config.model);
                let budgetState = createBudgetState();
                let messages = toMessagesWithParts(input.messages, "chat-agent");
                let lastAssistantText = "";
                const steps: AgentStep[] = [];
                let compactionCount = 0;
                let continuationCount = 0;
                const startTime = Date.now();
                const totalUsage: TokenUsage = {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                };

                const trackingSink: Sink = {
                  onMessage: (message) => {
                    if (message.info.role === "assistant") {
                      const tokens = (message.info as Message.AssistantMessage).tokens;
                      totalUsage.inputTokens += tokens.input;
                      totalUsage.outputTokens += tokens.output;
                      totalUsage.totalTokens += tokens.input + tokens.output;
                      budgetState = recordTokenUsage(budgetState, tokens.input, tokens.output);
                    }
                    const text = message.parts
                      .filter((part): part is Message.TextPart => part.type === "text")
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

                const configuredToolChoice = (
                  config as ChatAgentConfig & { toolChoice?: "auto" | "required" | "none" }
                ).toolChoice;

                if ((config.tools?.length ?? 0) > 0 && !config.toolExecutor) {
                  throw new Error("toolExecutor is required when tools are provided");
                }

                const engine = MiddlewareEngine.create();
                engine.register(createBudgetReassuranceMiddleware());
                engine.register(createBudgetWarningMiddleware());
                for (const reg of fromConfig({
                  hooks: config.hooks,
                  stepGuard: config.stepGuard,
                })) {
                  engine.register(reg);
                }
                if (config.compaction) {
                  engine.register(createCompactionMiddleware(config.compaction));
                }
                for (const reg of config.middleware ?? []) {
                  engine.register(reg);
                }

                while (true) {
                  const budgetStatus = checkBudget(budgetState, config.budget);
                  if (budgetStatus === "exceeded") {
                    return {
                      text: lastAssistantText,
                      steps,
                      usage: totalUsage,
                      finishReason: "max-steps",
                      compactionCount: compactionCount > 0 ? compactionCount : undefined,
                    };
                  }

                  config.eventEmitter?.emit("agent.turn.start", {
                    sessionId: "chat-agent",
                    time: Date.now(),
                    turnIndex: budgetState.turns,
                  });

                  const preTurnVerdict = await engine.dispatch("pre_turn", {
                    steps,
                    usage: totalUsage,
                    turnCount: budgetState.turns,
                    isCompletion: false,
                    continuationCount,
                    elapsedMs: Date.now() - startTime,
                    messages,
                    budgetState,
                    budget: config.budget,
                    eventEmitter: config.eventEmitter,
                  });

                  if (preTurnVerdict.action === "inject") {
                    messages = [
                      ...messages,
                      createUserMessage(preTurnVerdict.message, "chat-agent"),
                    ];
                  } else if (preTurnVerdict.action === "abort") {
                    return {
                      text: lastAssistantText,
                      steps,
                      usage: totalUsage,
                      finishReason: preTurnVerdict.reason === "stalled" ? "stalled" : "stop",
                      compactionCount: compactionCount > 0 ? compactionCount : undefined,
                      guardAborted: preTurnVerdict.reason !== "stalled",
                    };
                  }

                  budgetState = recordTurn(budgetState);

                  if (config.signal?.aborted) {
                    throw new Error("aborted");
                  }

                  let effectiveMessages = messages;
                  if (config.memory) {
                    const lastUserText = getLastUserMessageText(messages);
                    if (lastUserText) {
                      const memoryResults = await config.memory.retrieve(lastUserText);
                      if (memoryResults.length > 0) {
                        effectiveMessages = prependContextMessage(
                          messages,
                          formatMemoryContext(memoryResults),
                          "chat-agent",
                        );
                      }
                    }
                  }

                  const hookedExecutor = config.toolExecutor
                    ? createToolExecutor({
                        toolExecutor: config.toolExecutor,
                        permission: config.permissions,
                        hooks: config.hooks,
                        stepGuard: config.stepGuard,
                        eventEmitter: config.eventEmitter,
                        getContext: () => ({
                          steps,
                          turnCount: budgetState.turns,
                          elapsedMs: Date.now() - startTime,
                        }),
                        source: "chat-agent",
                      })
                    : undefined;

                  const runInput: RunInput = {
                    messages: effectiveMessages,
                    tools: config.tools ?? [],
                    system: buildSystemPrompt(config.systemPrompt, config.tools ?? []),
                    signal: config.signal,
                    model: providerModel,
                    toolExecutor: hookedExecutor,
                    toolChoice: configuredToolChoice,
                    maxSteps: config.budget?.maxToolCalls ?? 24,
                    providerOptions: config.providerOptions,
                  };

                  const outcome = await llmRun(runInput, trackingSink);

                  if (outcome.type === "stop") {
                    config.eventEmitter?.emit("agent.turn.complete", {
                      sessionId: "chat-agent",
                      time: Date.now(),
                      turnIndex: budgetState.turns,
                      usage: {
                        inputTokens: totalUsage.inputTokens,
                        outputTokens: totalUsage.outputTokens,
                        totalTokens: totalUsage.totalTokens,
                      },
                    });

                    const step: AgentStep = {
                      type: "text",
                      content: lastAssistantText,
                    };
                    steps.push(step);

                    if (config.onStepFinish) {
                      await config.onStepFinish(step);
                    }

                    const postTurnVerdict = await engine.dispatch("post_turn", {
                      steps,
                      usage: totalUsage,
                      turnCount: budgetState.turns,
                      isCompletion: true,
                      continuationCount,
                      elapsedMs: Date.now() - startTime,
                      messages,
                      budgetState,
                      budget: config.budget,
                      eventEmitter: config.eventEmitter,
                    });

                    if (postTurnVerdict.action === "inject") {
                      const parentID =
                        messages.length > 0 ? messages[messages.length - 1].info.id : "";
                      messages = [
                        ...messages,
                        createAssistantMessage(lastAssistantText, parentID, "chat-agent"),
                        createUserMessage(postTurnVerdict.message, "chat-agent"),
                      ];

                      const compactionVerdict = await engine.dispatch("post_compaction", {
                        steps,
                        usage: totalUsage,
                        turnCount: budgetState.turns,
                        isCompletion: true,
                        continuationCount,
                        elapsedMs: Date.now() - startTime,
                        messages,
                        budgetState,
                        budget: config.budget,
                        eventEmitter: config.eventEmitter,
                      });
                      if (compactionVerdict.action === "transform") {
                        const payload = compactionVerdict.input as { messages?: unknown };
                        if (Array.isArray(payload.messages)) {
                          messages = payload.messages as Message.WithParts[];
                          compactionCount += 1;
                        }
                      }

                      continuationCount++;
                      continue;
                    }

                    if (postTurnVerdict.action === "abort") {
                      return {
                        text: lastAssistantText,
                        steps,
                        usage: totalUsage,
                        finishReason: postTurnVerdict.reason === "stalled" ? "stalled" : "stop",
                        compactionCount: compactionCount > 0 ? compactionCount : undefined,
                        guardAborted: postTurnVerdict.reason !== "stalled",
                      };
                    }

                    return {
                      text: lastAssistantText,
                      steps,
                      usage: totalUsage,
                      finishReason: "stop",
                      compactionCount: compactionCount > 0 ? compactionCount : undefined,
                    };
                  }

                  if (outcome.type === "aborted") {
                    throw new Error("aborted");
                  }

                  if (outcome.type === "error") {
                    throw new Error(outcome.error.message);
                  }

                  throw new Error("Unreachable outcome in SDK-driven path");
                }
              } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                const retryReason = classifyRetryReason(lastError);

                if (shouldRetry(retryPolicy, retryReason, attempt)) {
                  const backoffMs = calculateBackoffMs(retryPolicy, attempt);
                  config.eventEmitter?.emit("agent.error.retry", {
                    sessionId: "chat-agent",
                    time: Date.now(),
                    attempt,
                    maxAttempts: retryPolicy.maxAttempts,
                    error: lastError,
                  });
                  await sleep(backoffMs);
                  attempt += 1;
                  continue;
                }

                throw error;
              }
            }

            throw new Error(lastError || "Max retry attempts exceeded");
          },
          {
            "agent.model": config.model.id,
            "agent.provider": config.model.provider,
          },
        );
      },
      async *stream(input: ChatAgentInput, sink?: Sink): AsyncIterable<AgentEvent> {
        yield* streamAgent(input, config, sink);
      },
    };
  }
}
