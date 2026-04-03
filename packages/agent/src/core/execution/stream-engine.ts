import { ModelsDev, Provider, run as llmRun, type RunInput } from "@openomni/llm";
import type { Guardrail, Message, Sink, Tool } from "@openomni/protocol";
import type { AgentEvent, AgentStep, ChatAgentConfig, ChatAgentInput, TokenUsage } from "../types";
import { createBudgetState, checkBudget, recordTurn } from "../budget";
import { createAssistantMessage, createUserMessage } from "../message-factory";
import { ToolGuard } from "../tool-guard";
import {
  DEFAULT_RETRY_POLICY,
  calculateBackoffMs,
  classifyRetryReason,
  shouldRetry,
  sleep,
} from "../retry";

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

function buildSystemPrompt(basePrompt: string | undefined, tools: Tool.Spec[]): string | undefined {
  const toolPrompts = tools
    .filter((t) => t.prompt)
    .map((t) => `## Tool: ${t.name}\n${t.prompt}`)
    .join("\n\n");

  if (!toolPrompts) return basePrompt;
  if (!basePrompt) return toolPrompts;
  return `${basePrompt}\n\n---\n\n${toolPrompts}`;
}

function createGuardedToolExecutor(
  toolExecutor: (call: Tool.Call) => Promise<Tool.Result>,
  permission: Guardrail.ToolPermission,
): (call: Tool.Call) => Promise<Tool.Result> {
  return async (call: Tool.Call): Promise<Tool.Result> => {
    const verdict = ToolGuard.check(call.tool, call.input, permission);
    if (verdict === "deny") {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Blocked: Tool "${call.tool}" is not permitted by policy]`,
        isError: true,
      };
    }
    if (verdict === "require_approval") {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Blocked: Tool "${call.tool}" requires approval]`,
        isError: true,
      };
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

      while (true) {
        if (checkBudget(budgetState, config.budget) === "exceeded") {
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

        budgetState = recordTurn(budgetState);

        if (config.signal?.aborted) throw new Error("aborted");

        const runInput: RunInput = {
          messages,
          tools: config.tools ?? [],
          system: buildSystemPrompt(config.systemPrompt, config.tools ?? []),
          signal: config.signal,
          model: providerModel,
          toolExecutor:
            config.toolExecutor && config.permissions
              ? createGuardedToolExecutor(config.toolExecutor, config.permissions)
              : config.toolExecutor,
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
          if (lastAssistantText) yield { type: "text_chunk", text: lastAssistantText };

          for (const toolCall of turnToolCalls) {
            yield { type: "tool_call_start", ...toolCall };
          }
          for (const toolResult of turnToolResults) {
            yield { type: "tool_call_complete", ...toolResult };
          }

          yield { type: "turn_complete", turnIndex, usage: turnUsage };

          const step: AgentStep = { type: "text", content: lastAssistantText };
          steps.push(step);
          if (config.onStepFinish) await config.onStepFinish(step);

          if (config.stepGuard) {
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
