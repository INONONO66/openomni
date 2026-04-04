import { ModelsDev, Provider, run as llmRun, TokenTracker, type RunInput } from "@openomni/llm";
import type { Guardrail, Message, Sink, Tool } from "@openomni/protocol";
import type {
  AgentEventEmitter,
  ChatAgentConfig,
  ChatAgentInput,
  AgentResult,
  AgentStep,
  ExecutionHooks,
  HookContext,
  HookVerdict,
  TokenUsage,
} from "./types";
import {
  createBudgetState,
  checkBudget,
  recordTurn,
  recordTokenUsage,
  describeBudgetRemaining,
} from "./budget";
import {
  DEFAULT_RETRY_POLICY,
  calculateBackoffMs,
  classifyRetryReason,
  shouldRetry,
  sleep,
} from "./retry";
import { streamAgent } from "./execution/stream-engine";
import { InMemoryCompactor } from "./execution/compaction";
import { Telemetry } from "./telemetry";
import type { AgentEvent } from "./types";
import type { MemoryResult } from "./memory";
import { createAssistantMessage, createUserMessage } from "./message-factory";
import { ToolGuard } from "./tool-guard";
import { buildSystemPrompt } from "./prompt-builder";

function summarizeInput(input: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(input);
    return str.length > 100 ? `${str.slice(0, 97)}...` : str;
  } catch {
    return "[unserializable]";
  }
}

/**
 * ChatAgent instance interface
 */
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
    throw new Error(`Model not found: ${model.id} for provider ${model.provider}`);
  }

  return Provider.fromModelsDevModel(providerData, rawModel as ModelsDev.Model);
}

function getLastUserMessageText(messages: Message.WithParts[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") {
      return messages[i].parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");
    }
  }
  return null;
}

function formatMemoryContext(results: MemoryResult[]): string {
  const entries = results.map((r) => `- ${r.content}`).join("\n");
  return `[Memory Context]\n${entries}`;
}

function prependContextMessage(
  messages: Message.WithParts[],
  contextText: string,
): Message.WithParts[] {
  return [createUserMessage(contextText, "chat-agent"), ...messages];
}

function toMessagesWithParts(messages: ChatAgentInput["messages"]): Message.WithParts[] {
  const output: Message.WithParts[] = [];

  for (const message of messages) {
    const parentID = output.length > 0 ? output[output.length - 1].info.id : "";
    output.push(
      message.role === "user"
        ? createUserMessage(message.content, "chat-agent")
        : createAssistantMessage(message.content, parentID, "chat-agent"),
    );
  }

  return output;
}

function createGuardedToolExecutor(
  toolExecutor: (call: Tool.Call) => Promise<Tool.Result>,
  permission: Guardrail.ToolPermission,
  eventEmitter?: AgentEventEmitter,
  stepGuard?: ChatAgentConfig["stepGuard"],
): (call: Tool.Call) => Promise<Tool.Result> {
  return async (call: Tool.Call): Promise<Tool.Result> => {
    const verdict = ToolGuard.check(call.tool, call.input, permission);
    if (verdict === "deny") {
      eventEmitter?.emit("agent.tool.blocked", {
        sessionId: "chat-agent",
        time: Date.now(),
        toolCallId: call.id,
        toolName: call.tool,
        reason: "denied by policy",
      });
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Blocked: Tool "${call.tool}" is not permitted by policy]`,
        isError: true,
      };
    }
    if (verdict === "require_approval") {
      if (stepGuard) {
        const syntheticStep: AgentStep = {
          type: "tool-call",
          content: `Tool "${call.tool}" requires approval`,
          toolCalls: [call],
        };
        const guardContext = {
          steps: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          turnCount: 0,
          isCompletion: false,
          continuationCount: 0,
          elapsedMs: 0,
        };
        try {
          const guardVerdict = await stepGuard(syntheticStep, guardContext);
          if (guardVerdict.action === "continue") {
            eventEmitter?.emit("agent.tool.invoked", {
              sessionId: "chat-agent",
              time: Date.now(),
              toolCallId: call.id,
              toolName: call.tool,
              inputSummary: summarizeInput(call.input),
            });
            return toolExecutor(call);
          }
        } catch (_error) {
          void _error;
        }
      }
      eventEmitter?.emit("agent.tool.blocked", {
        sessionId: "chat-agent",
        time: Date.now(),
        toolCallId: call.id,
        toolName: call.tool,
        reason: "requires approval",
      });
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Blocked: Tool "${call.tool}" requires approval]`,
        isError: true,
      };
    }
    eventEmitter?.emit("agent.tool.invoked", {
      sessionId: "chat-agent",
      time: Date.now(),
      toolCallId: call.id,
      toolName: call.tool,
      inputSummary: summarizeInput(call.input),
    });
    return toolExecutor(call);
  };
}

function createHookedToolExecutor(
  toolExecutor: (call: Tool.Call) => Promise<Tool.Result>,
  hooks: ExecutionHooks | undefined,
  getContext: () => Omit<HookContext, "toolName" | "toolCallId" | "input">,
): (call: Tool.Call) => Promise<Tool.Result> {
  if (!hooks?.preToolUse) return toolExecutor;

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const context: HookContext = {
      ...getContext(),
      toolName: call.tool,
      toolCallId: call.id,
      input: call.input,
    };

    let verdict: HookVerdict;
    try {
      verdict = await hooks.preToolUse!(context);
    } catch (err) {
      console.warn("[hooks.preToolUse] threw, treating as continue:", err);
      verdict = { action: "continue" };
    }

    if (verdict.action === "skip") {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Skipped: ${verdict.reason ?? "hook"}]`,
        isError: false,
      };
    }

    if (verdict.action === "abort") {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Aborted: ${verdict.reason ?? "hook"}]`,
        isError: true,
      };
    }

    if (verdict.action === "transform") {
      const transformed: Tool.Call = { ...call, input: verdict.input };
      return toolExecutor(transformed);
    }

    if (verdict.action === "retry") {
      console.warn(
        '[hooks.preToolUse] "retry" verdict is not supported for preToolUse, treating as continue',
      );
    }

    if (verdict.action === "inject") {
      console.warn(
        '[hooks.preToolUse] "inject" verdict is not supported for preToolUse, treating as continue',
      );
    }

    return toolExecutor(call);
  };
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
                let messages = toMessagesWithParts(input.messages);
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
                      const cost = TokenTracker.calculateCost(
                        {
                          inputTokens: tokens.input,
                          outputTokens: tokens.output,
                        },
                        config.model.id,
                      );
                      budgetState = recordTokenUsage(
                        budgetState,
                        tokens.input,
                        tokens.output,
                        cost.totalCost,
                      );
                      totalUsage.totalCost = (totalUsage.totalCost ?? 0) + cost.totalCost;
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

                let reassuranceIssued = false;
                let warningIssued = false;

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

                  if (budgetStatus === "reassurance" && !reassuranceIssued) {
                    const remaining = describeBudgetRemaining(budgetState, config.budget);
                    messages = [
                      ...messages,
                      createUserMessage(
                        `[Budget Status] ${remaining}. You have plenty of budget remaining. Do NOT rush or skip tasks. Complete your work thoroughly.`,
                        "chat-agent",
                      ),
                    ];
                    reassuranceIssued = true;
                    config.eventEmitter?.emit("agent.budget.reassurance", {
                      sessionId: "chat-agent",
                      time: Date.now(),
                      remaining,
                      threshold: config.budget?.reassuranceThreshold ?? 0.6,
                    });
                  }
                  if (budgetStatus === "warning" && !warningIssued) {
                    const remaining = describeBudgetRemaining(budgetState, config.budget);
                    messages = [
                      ...messages,
                      createUserMessage(
                        `[Budget Warning] ${remaining}. Wrap up your current task and provide a summary.`,
                        "chat-agent",
                      ),
                    ];
                    warningIssued = true;
                    config.eventEmitter?.emit("agent.budget.warning", {
                      sessionId: "chat-agent",
                      time: Date.now(),
                      remaining,
                      threshold: config.budget?.warningThreshold ?? 0.8,
                    });
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
                        );
                      }
                    }
                  }

                  const baseExecutor =
                    config.toolExecutor && config.permissions
                      ? createGuardedToolExecutor(
                          config.toolExecutor,
                          config.permissions,
                          config.eventEmitter,
                          config.stepGuard,
                        )
                      : config.toolExecutor;

                  const hookedExecutor = baseExecutor
                    ? createHookedToolExecutor(baseExecutor, config.hooks, () => ({
                        steps,
                        turnCount: budgetState.turns,
                        elapsedMs: Date.now() - startTime,
                      }))
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
                        totalCost: totalUsage.totalCost,
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

                    if (config.hooks?.postTurn) {
                      if (config.stepGuard) {
                        console.warn(
                          "[hooks] Both hooks.postTurn and stepGuard are set. hooks.postTurn takes precedence.",
                        );
                      }

                      const hookContext: HookContext = {
                        steps,
                        turnCount: budgetState.turns,
                        elapsedMs: Date.now() - startTime,
                      };

                      let postTurnVerdict: HookVerdict;
                      try {
                        postTurnVerdict = await config.hooks.postTurn(hookContext);
                      } catch (err) {
                        console.warn("[hooks.postTurn] threw, treating as continue:", err);
                        postTurnVerdict = { action: "continue" };
                      }

                      if (postTurnVerdict.action === "inject") {
                        const parentID =
                          messages.length > 0 ? messages[messages.length - 1].info.id : "";
                        messages = [
                          ...messages,
                          createAssistantMessage(lastAssistantText, parentID, "chat-agent"),
                          createUserMessage(postTurnVerdict.message, "chat-agent"),
                        ];

                        if (config.compaction) {
                          const totalTokens =
                            budgetState.totalInputTokens + budgetState.totalOutputTokens;
                          if (InMemoryCompactor.shouldCompact(totalTokens, config.compaction)) {
                            const result = await InMemoryCompactor.compact(
                              messages,
                              config.compaction,
                            );
                            if (result.compacted) {
                              const messagesBefore = messages.length;
                              messages = result.messages;
                              compactionCount += 1;
                              config.eventEmitter?.emit("agent.compaction", {
                                sessionId: "chat-agent",
                                time: Date.now(),
                                messagesBefore,
                                messagesAfter: result.messages.length,
                              });
                            }
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
                          finishReason: "stop",
                          compactionCount: compactionCount > 0 ? compactionCount : undefined,
                          guardAborted: true,
                        };
                      }
                    } else if (config.stepGuard) {
                      const verdict = await config.stepGuard(step, {
                        steps,
                        usage: totalUsage,
                        turnCount: budgetState.turns,
                        isCompletion: true,
                        continuationCount,
                        elapsedMs: Date.now() - startTime,
                      });

                      if (verdict.action === "inject") {
                        const parentID =
                          messages.length > 0 ? messages[messages.length - 1].info.id : "";
                        messages = [
                          ...messages,
                          createAssistantMessage(lastAssistantText, parentID, "chat-agent"),
                          createUserMessage(verdict.message, "chat-agent"),
                        ];

                        if (config.compaction) {
                          const totalTokens =
                            budgetState.totalInputTokens + budgetState.totalOutputTokens;
                          if (InMemoryCompactor.shouldCompact(totalTokens, config.compaction)) {
                            const result = await InMemoryCompactor.compact(
                              messages,
                              config.compaction,
                            );
                            if (result.compacted) {
                              const messagesBefore = messages.length;
                              messages = result.messages;
                              compactionCount += 1;
                              config.eventEmitter?.emit("agent.compaction", {
                                sessionId: "chat-agent",
                                time: Date.now(),
                                messagesBefore,
                                messagesAfter: result.messages.length,
                              });
                            }
                          }
                        }

                        continuationCount++;
                        continue;
                      }

                      if (verdict.action === "abort") {
                        return {
                          text: lastAssistantText,
                          steps,
                          usage: totalUsage,
                          finishReason: "stop",
                          compactionCount: compactionCount > 0 ? compactionCount : undefined,
                          guardAborted: true,
                        };
                      }
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
