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
import {
  createBudgetState,
  checkBudget,
  recordTurn,
  recordTokenUsage,
  describeBudgetRemaining,
} from "../budget";
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
import { MiddlewareEngine, fromConfig } from "../middleware";
import type { MemoryResult } from "../memory";
import {
  createBudgetReassuranceMiddleware,
  createBudgetWarningMiddleware,
  createCompactionMiddleware,
} from "../middleware/builtin";

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
  return [createUserMessage(contextText, "stream-engine"), ...messages];
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
        } catch {
          // stepGuard threw; fall through to approval-denied response
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

    if (verdict.action === "retry" || verdict.action === "inject") {
      console.warn(`[hooks.preToolUse] "${verdict.action}" not supported, treating as continue`);
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

      const engine = MiddlewareEngine.create();
      engine.register(createBudgetReassuranceMiddleware());
      engine.register(createBudgetWarningMiddleware());
      for (const reg of fromConfig({ hooks: config.hooks, stepGuard: config.stepGuard })) {
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
          messages = [...messages, createUserMessage(preTurnVerdict.message, "stream-engine")];
          if (preTurnVerdict.message.startsWith("[Budget Status]")) {
            yield {
              type: "budget_reassurance",
              remaining: describeBudgetRemaining(budgetState, config.budget),
            };
          } else if (preTurnVerdict.message.startsWith("[Budget Warning]")) {
            yield {
              type: "budget_warning",
              remaining: describeBudgetRemaining(budgetState, config.budget),
            };
          }
        } else if (preTurnVerdict.action === "abort") {
          yield {
            type: "complete",
            result: {
              text: lastAssistantText,
              steps,
              usage: totalUsage,
              finishReason: preTurnVerdict.reason === "stalled" ? "stalled" : "stop",
              guardAborted: preTurnVerdict.reason !== "stalled",
            },
          };
          return;
        }

        budgetState = recordTurn(budgetState);

        if (config.signal?.aborted) throw new Error("aborted");

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
              budgetState = recordTokenUsage(budgetState, tokens.input, tokens.output);
            }
            const text = message.parts
              .filter((part): part is Message.TextPart => part.type === "text")
              .map((part) => part.text)
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
              const payload = compactionVerdict.input as Record<string, unknown>;
              if (Array.isArray(payload.messages)) {
                messages = payload.messages as Message.WithParts[];
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
                finishReason: postTurnVerdict.reason === "stalled" ? "stalled" : "stop",
                guardAborted: postTurnVerdict.reason !== "stalled",
              },
            };
            return;
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
        throw new Error("unreachable");
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
