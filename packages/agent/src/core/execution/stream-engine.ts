import { run as llmRun, type RunInput } from "@openomni/llm";
import type { Message, Sink, Tool } from "@openomni/protocol";
import type {
  AgentEvent,
  AgentStep,
  ChatAgentConfig,
  ChatAgentInput,
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
import {
  DEFAULT_RETRY_POLICY,
  calculateBackoffMs,
  classifyRetryReason,
  shouldRetry,
  sleep,
} from "../retry";
import { buildSystemPrompt } from "../prompt-builder";
import { MiddlewareEngine, fromConfig } from "../middleware";
import {
  createBudgetReassuranceMiddleware,
  createBudgetWarningMiddleware,
  createCompactionMiddleware,
  createMemoryMiddleware,
  createToolGuardMiddleware,
} from "../middleware/builtin";
import { resolveProviderModel, toMessagesWithParts } from "./shared";
import { createToolExecutor } from "./tool-executor";

export async function* streamAgent(
  input: ChatAgentInput,
  config: ChatAgentConfig,
  sink?: Sink,
): AsyncGenerator<AgentEvent> {
  const retryPolicy = DEFAULT_RETRY_POLICY;
  let attempt = 1;
  let lastError = "";

  while (attempt <= retryPolicy.maxAttempts) {
    let budgetState = createBudgetState();
    let messages = toMessagesWithParts(input.messages, "stream-engine");
    let lastAssistantText = "";
    const steps: AgentStep[] = [];
    const totalUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let continuationCount = 0;
    let compactionCount = 0;
    const startTime = Date.now();
    const engine = MiddlewareEngine.create();
    engine.register(createBudgetReassuranceMiddleware());
    engine.register(createBudgetWarningMiddleware());
    for (const reg of fromConfig({ hooks: config.hooks, stepGuard: config.stepGuard })) {
      engine.register(reg);
    }
    if (config.permissions) {
      engine.register(
        createToolGuardMiddleware({
          permission: config.permissions,
          stepGuard: config.stepGuard,
          eventEmitter: config.eventEmitter,
          source: "stream-engine",
        }),
      );
    }
    if (config.memory) {
      engine.register(createMemoryMiddleware(config.memory));
    }
    if (config.compaction) {
      engine.register(createCompactionMiddleware(config.compaction));
    }
    for (const reg of config.middleware ?? []) {
      engine.register(reg);
    }
    try {
      const providerModel = await resolveProviderModel(config.model);
      let turnIndex = 0;
      const configuredToolChoice = (
        config as ChatAgentConfig & { toolChoice?: "auto" | "required" | "none" }
      ).toolChoice;

      if ((config.tools?.length ?? 0) > 0 && !config.toolExecutor) {
        throw new Error("toolExecutor is required when tools are provided");
      }

      const preRunVerdict = await engine.dispatch("pre_run", {
        steps,
        usage: totalUsage,
        turnCount: 0,
        isCompletion: false,
        continuationCount: 0,
        elapsedMs: 0,
        messages,
        budgetState,
        budget: config.budget,
        eventEmitter: config.eventEmitter,
      });
      if (preRunVerdict.action === "abort") {
        yield {
          type: "complete",
          result: {
            text: "",
            steps: [],
            usage: totalUsage,
            finishReason: "stop",
            guardAborted: true,
          },
        };
        return;
      }
      if (preRunVerdict.action === "inject") {
        messages.push(createUserMessage(preRunVerdict.message, "stream-engine"));
      }

      while (true) {
        const budgetStatus = checkBudget(budgetState, config.budget);
        if (budgetStatus === "exceeded") {
          const postRunVerdict = await engine.dispatch("post_run", {
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
          if (postRunVerdict.action === "transform") {
            const payload = postRunVerdict.input as { text?: unknown };
            if (typeof payload.text === "string") lastAssistantText = payload.text;
          }
          yield {
            type: "complete",
            result: {
              text: lastAssistantText,
              steps,
              usage: totalUsage,
              finishReason: "max-steps",
              compactionCount: compactionCount > 0 ? compactionCount : undefined,
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
          messages.push(createUserMessage(preTurnVerdict.message, "stream-engine"));
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
              compactionCount: compactionCount > 0 ? compactionCount : undefined,
            },
          };
          return;
        }

        budgetState = recordTurn(budgetState);

        if (config.signal?.aborted) throw new Error("aborted");

        const effectiveMessages = messages;

        const preToolUseVerdicts: HookVerdict[] = [];

        const hookedExecutor = config.toolExecutor
          ? createToolExecutor({
              toolExecutor: config.toolExecutor,
              engine,
              getContext: () => ({
                steps,
                turnCount: budgetState.turns,
                elapsedMs: Date.now() - startTime,
                usage: totalUsage,
              }),
              onVerdict: (verdict) => preToolUseVerdicts.push(verdict),
            })
          : undefined;

        let system = buildSystemPrompt(config.systemPrompt, config.tools ?? []);
        const spVerdict = await engine.dispatchSystemPrompt({
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
        if (spVerdict.systemPrompt) system = spVerdict.systemPrompt;
        if (spVerdict.prependContext) system = `${spVerdict.prependContext}\n\n${system}`;
        if (spVerdict.appendContext) system = `${system}\n\n${spVerdict.appendContext}`;

        const runInput: RunInput = {
          messages: effectiveMessages,
          tools: config.tools ?? [],
          system,
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
            messages.push(
              createAssistantMessage(lastAssistantText, parentID, "stream-engine"),
              createUserMessage(postTurnVerdict.message, "stream-engine"),
            );

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
                compactionCount += 1;
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
                compactionCount: compactionCount > 0 ? compactionCount : undefined,
              },
            };
            return;
          }

          {
            const postRunVerdict = await engine.dispatch("post_run", {
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
            if (postRunVerdict.action === "transform") {
              const payload = postRunVerdict.input as { text?: unknown };
              if (typeof payload.text === "string") lastAssistantText = payload.text;
            }
          }

          yield {
            type: "complete",
            result: {
              text: lastAssistantText,
              steps,
              usage: totalUsage,
              finishReason: "stop",
              compactionCount: compactionCount > 0 ? compactionCount : undefined,
            },
          };
          return;
        }

        if (outcome.type === "aborted") throw new Error("aborted");
        if (outcome.type === "error") throw new Error(outcome.error.message);
        throw new Error("unreachable");
      }
    } catch (error) {
      const onErrorVerdict = await engine.dispatch("on_error", {
        toolInput: { error: error instanceof Error ? error : new Error(String(error)) },
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

      if (onErrorVerdict.action === "abort") {
        yield {
          type: "complete",
          result: {
            text: lastAssistantText,
            steps,
            usage: totalUsage,
            finishReason: "stop",
            guardAborted: true,
            compactionCount: compactionCount > 0 ? compactionCount : undefined,
          },
        };
        return;
      }

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
