import { ModelsDev, Provider, run as llmRun, type RunInput } from "@openomni/llm";
import type { Guardrail, Message, Sink, Tool } from "@openomni/protocol";
import type {
  AgentEvent,
  AgentEventEmitter,
  AgentStep,
  ChatAgentConfig,
  ChatAgentInput,
  ExecutionHooks,
  HookContext,
  HookVerdict,
  TokenUsage,
} from "../types";
import { createBudgetState, checkBudget, recordTurn, describeBudgetRemaining } from "../budget";
import { createAssistantMessage, createUserMessage } from "../message-factory";
import { ToolGuard } from "../tool-guard";
import {
  DEFAULT_RETRY_POLICY,
  calculateBackoffMs,
  classifyRetryReason,
  shouldRetry,
  sleep,
} from "../retry";
import { buildSystemPrompt } from "../prompt-builder";
import { InMemoryCompactor } from "./compaction";

function summarizeInput(input: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(input);
    return str.length > 100 ? `${str.slice(0, 97)}...` : str;
  } catch {
    return "[unserializable]";
  }
}

async function resolveProviderModel(model: {
  provider: string;
  id: string;
}): Promise<Provider.Model> {
  const data = await ModelsDev.get();
  const providerData = data[model.provider];
  if (!providerData) throw new Error(`Provider not found: ${model.provider}`);
  const rawModel = providerData.models?.[model.id];
  if (!rawModel) throw new Error(`Model not found: ${model.id}`);
  return Provider.fromModelsDevModel(providerData, rawModel as ModelsDev.Model);
}

function toMessagesWithParts(messages: ChatAgentInput["messages"]): Message.WithParts[] {
  const output: Message.WithParts[] = [];
  for (const message of messages) {
    const parentID = output.length > 0 ? output[output.length - 1].info.id : "";
    output.push(
      message.role === "user"
        ? createUserMessage(message.content, "stream-engine")
        : createAssistantMessage(message.content, parentID, "stream-engine"),
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
    let verdict: "allow" | "deny" | "require_approval";
    try {
      verdict = ToolGuard.check(call.tool, call.input, permission);
    } catch {
      verdict = "deny";
    }
    if (verdict === "deny") {
      eventEmitter?.emit("agent.tool.blocked", {
        sessionId: "stream-engine",
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
              sessionId: "stream-engine",
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
        sessionId: "stream-engine",
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
      sessionId: "stream-engine",
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
  onVerdict?: (verdict: HookVerdict) => void,
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

    onVerdict?.(verdict);

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

export async function* streamAgent(
  input: ChatAgentInput,
  config: ChatAgentConfig,
  sink?: Sink,
): AsyncGenerator<AgentEvent> {
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
      const totalUsage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      let turnIndex = 0;
      let continuationCount = 0;
      const startTime = Date.now();
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
          yield {
            type: "complete",
            result: {
              text: lastAssistantText,
              steps,
              usage: totalUsage,
              finishReason: "max-steps",
            },
          };
          return;
        }

        config.eventEmitter?.emit("agent.turn.start", {
          sessionId: "stream-engine",
          time: Date.now(),
          turnIndex: budgetState.turns,
        });

        if (budgetStatus === "reassurance" && !reassuranceIssued) {
          const remaining = describeBudgetRemaining(budgetState, config.budget);
          messages = [
            ...messages,
            createUserMessage(
              `[Budget Status] ${remaining}. You have plenty of budget remaining. Do NOT rush or skip tasks. Complete your work thoroughly.`,
              "stream-engine",
            ),
          ];
          reassuranceIssued = true;
          config.eventEmitter?.emit("agent.budget.reassurance", {
            sessionId: "stream-engine",
            time: Date.now(),
            remaining,
            threshold: config.budget?.reassuranceThreshold ?? 0.6,
          });
          yield { type: "budget_reassurance", remaining };
        }
        if (budgetStatus === "warning" && !warningIssued) {
          const remaining = describeBudgetRemaining(budgetState, config.budget);
          messages = [
            ...messages,
            createUserMessage(
              `[Budget Warning] ${remaining}. Wrap up your current task and provide a summary.`,
              "stream-engine",
            ),
          ];
          warningIssued = true;
          config.eventEmitter?.emit("agent.budget.warning", {
            sessionId: "stream-engine",
            time: Date.now(),
            remaining,
            threshold: config.budget?.warningThreshold ?? 0.8,
          });
          yield { type: "budget_warning", remaining };
        }

        budgetState = recordTurn(budgetState);

        if (config.signal?.aborted) throw new Error("aborted");

        const preToolUseVerdicts: HookVerdict[] = [];

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
          ? createHookedToolExecutor(
              baseExecutor,
              config.hooks,
              () => ({
                steps,
                turnCount: budgetState.turns,
                elapsedMs: Date.now() - startTime,
              }),
              (verdict) => preToolUseVerdicts.push(verdict),
            )
          : undefined;

        const runInput: RunInput = {
          messages,
          tools: config.tools ?? [],
          system: buildSystemPrompt(config.systemPrompt, config.tools ?? []),
          signal: config.signal,
          model: providerModel,
          toolExecutor: hookedExecutor,
          toolChoice: configuredToolChoice,
          maxSteps: config.budget?.maxToolCalls ?? 24,
        };

        const turnUsage: TokenUsage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
        const turnToolCalls: Array<{
          toolCallId: string;
          toolName: string;
          args: Record<string, unknown>;
        }> = [];
        const turnToolResults: Array<{
          toolCallId: string;
          result: Tool.Result;
        }> = [];

        const trackingSink: Sink = {
          onMessage: (message: Message.WithParts) => {
            if (message.info.role === "assistant") {
              const tokens = (message.info as Message.AssistantMessage).tokens;
              turnUsage.inputTokens += tokens.input;
              turnUsage.outputTokens += tokens.output;
              turnUsage.totalTokens += tokens.input + tokens.output;
              totalUsage.inputTokens += tokens.input;
              totalUsage.outputTokens += tokens.output;
              totalUsage.totalTokens += tokens.input + tokens.output;
            }
            const text = message.parts
              .filter((part: Message.Part): part is Message.TextPart => part.type === "text")
              .map((part: Message.TextPart) => part.text)
              .join("");
            if (text) lastAssistantText = text;
            sink?.onMessage(message);
          },
          onToolCall: (call) => {
            turnToolCalls.push({
              toolCallId: call.id,
              toolName: call.tool,
              args: call.input,
            });
            sink?.onToolCall(call);
          },
          onToolResult: (result) => {
            turnToolResults.push({ toolCallId: result.toolCallId, result });
            sink?.onToolResult(result);
          },
          onSnapshot: sink?.onSnapshot ?? (() => undefined),
        };

        const outcome = await llmRun(runInput, trackingSink);

        if (outcome.type === "stop") {
          config.eventEmitter?.emit("agent.turn.complete", {
            sessionId: "stream-engine",
            time: Date.now(),
            turnIndex,
            usage: {
              inputTokens: totalUsage.inputTokens,
              outputTokens: totalUsage.outputTokens,
              totalTokens: totalUsage.totalTokens,
              totalCost: totalUsage.totalCost,
            },
          });

          if (lastAssistantText) yield { type: "text_chunk", text: lastAssistantText };

          for (const toolCall of turnToolCalls) {
            yield { type: "tool_call_start", ...toolCall };
          }
          for (const toolResult of turnToolResults) {
            yield { type: "tool_call_complete", ...toolResult };
          }
          for (const verdict of preToolUseVerdicts) {
            yield {
              type: "hook_verdict",
              timing: "pre_tool_use",
              action: verdict.action,
              reason: "reason" in verdict ? verdict.reason : undefined,
            };
          }

          yield { type: "turn_complete", turnIndex, usage: turnUsage };

          const step: AgentStep = { type: "text", content: lastAssistantText };
          steps.push(step);
          if (config.onStepFinish) await config.onStepFinish(step);

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

            yield {
              type: "hook_verdict",
              timing: "post_turn",
              action: postTurnVerdict.action,
              reason: "reason" in postTurnVerdict ? postTurnVerdict.reason : undefined,
            };

            if (postTurnVerdict.action === "inject") {
              const parentID = messages.length > 0 ? messages[messages.length - 1].info.id : "";
              messages = [
                ...messages,
                createAssistantMessage(lastAssistantText, parentID, "stream-engine"),
                createUserMessage(postTurnVerdict.message, "stream-engine"),
              ];

              if (config.compaction) {
                const totalTokens = budgetState.totalInputTokens + budgetState.totalOutputTokens;
                if (InMemoryCompactor.shouldCompact(totalTokens, config.compaction)) {
                  const result = await InMemoryCompactor.compact(messages, config.compaction);
                  if (result.compacted) {
                    const messagesBefore = messages.length;
                    messages = result.messages;
                    config.eventEmitter?.emit("agent.compaction", {
                      sessionId: "stream-engine",
                      time: Date.now(),
                      messagesBefore,
                      messagesAfter: result.messages.length,
                    });
                  }
                }
              }

              continuationCount++;
              turnIndex++;
              continue;
            }

            if (postTurnVerdict.action === "abort") {
              yield {
                type: "complete",
                result: {
                  text: lastAssistantText,
                  steps,
                  usage: totalUsage,
                  finishReason: "stop",
                  guardAborted: true,
                },
              };
              return;
            }
          } else if (config.stepGuard) {
            const verdict = await config.stepGuard(step, {
              steps,
              usage: totalUsage,
              turnCount: turnIndex,
              isCompletion: true,
              continuationCount,
              elapsedMs: Date.now() - startTime,
            });

            if (verdict.action === "inject") {
              const parentID = messages.length > 0 ? messages[messages.length - 1].info.id : "";
              messages = [
                ...messages,
                createAssistantMessage(lastAssistantText, parentID, "stream-engine"),
                createUserMessage(verdict.message, "stream-engine"),
              ];
              continuationCount++;
              turnIndex++;
              continue;
            }

            if (verdict.action === "abort") {
              yield {
                type: "complete",
                result: {
                  text: lastAssistantText,
                  steps,
                  usage: totalUsage,
                  finishReason: "stop",
                  guardAborted: true,
                },
              };
              return;
            }
          }

          yield {
            type: "complete",
            result: {
              text: lastAssistantText,
              steps,
              usage: totalUsage,
              finishReason: "stop",
            },
          };
          return;
        }

        if (outcome.type === "aborted") throw new Error("aborted");
        if (outcome.type === "error") throw new Error(outcome.error.message);
        throw new Error("Unreachable outcome in SDK-driven path");
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const retryReason = classifyRetryReason(lastError);

      if (shouldRetry(retryPolicy, retryReason, attempt)) {
        const backoffMs = calculateBackoffMs(retryPolicy, attempt);
        config.eventEmitter?.emit("agent.error.retry", {
          sessionId: "stream-engine",
          time: Date.now(),
          attempt,
          maxAttempts: retryPolicy.maxAttempts,
          error: lastError,
        });
        yield {
          type: "error",
          error: error instanceof Error ? error : new Error(lastError),
          willRetry: true,
        };
        await sleep(backoffMs);
        attempt += 1;
        continue;
      }

      yield {
        type: "error",
        error: error instanceof Error ? error : new Error(lastError),
        willRetry: false,
      };
      throw error;
    }
  }

  throw new Error(lastError || "Max retry attempts exceeded");
}
