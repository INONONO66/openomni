import type { Sink, Message, Tool, Run } from "@openomni/protocol";
import { LlmCall, Operational } from "@openomni/protocol";
import type { SDKMessage } from "./message";
import { Processor } from "./processor";
import { toModelMessages } from "./message";
import type { Provider } from "./provider";
import { getLanguage } from "./provider/sdk";
import { Auth } from "./auth/storage";
import { Bus } from "@openomni/session";

/**
 * Input for the run() function.
 *
 * The function resolves auth credentials for the configured model
 * and calls the real provider SDK.
 */
export interface RunInput {
  messages: Message.WithParts[];
  tools: Tool.Spec[];
  system?: string;
  signal?: AbortSignal;
  model: Provider.Model;
  auth?: Auth.Info;
  allowAuthFallback?: boolean;
  toolExecutor?: (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
  toolChoice?: "auto" | "required" | "none";
  maxSteps?: number;
  providerOptions?: Record<string, unknown>;
  trace?: { traceId?: string; runId?: string };
}

export async function run(input: RunInput, sink: Sink): Promise<Run.Outcome> {
  const { messages, system = "", signal, model } = input;

  const abortController = signal ? null : new AbortController();
  const abortSignal = signal ?? abortController?.signal;
  if (!abortSignal) {
    throw new Error("Failed to initialize abort signal");
  }
  if (abortSignal.aborted) {
    return { type: "aborted" };
  }

  const sessionID = messages[0]?.info.sessionID || `session-${crypto.randomUUID()}`;
  const messageID = `msg-${crypto.randomUUID()}`;
  const parentID = messages[messages.length - 1]?.info.id || "";

  const assistantMessage: Message.AssistantMessage = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: model.id,
    providerID: model.providerID,
    agent: "default",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };

  const createStream: Processor.ProcessorOptions["createStream"] = async (streamInput) => {
    const ai = await import("ai");
    const auth =
      input.auth ??
      (input.allowAuthFallback === false ? undefined : await Auth.get(model.providerID));
    if (!auth) {
      throw new Error(
        `No authentication found for provider: ${model.providerID}. Configure provider credentials or use a proxy auth provider first.`,
      );
    }

    const languageModel = getLanguage(model, auth);

    const normalizedMessages = toModelMessages(messages, model);

    const systemMessages: SDKMessage[] = streamInput.system
      ? [{ role: "system" as const, content: streamInput.system }]
      : [];

    const sdkTools: Record<string, unknown> = {};
    for (const spec of input.tools) {
      if (input.toolExecutor) {
        sdkTools[spec.name] = {
          type: "function" as const,
          description: spec.description,
          inputSchema: ai.jsonSchema(spec.inputSchema),
          execute: async (
            args: Record<string, unknown>,
            options?: { toolCallId?: string; abortSignal?: AbortSignal },
          ) => {
            const call: Tool.Call = {
              id: options?.toolCallId ?? crypto.randomUUID(),
              tool: spec.name,
              input: args,
            };
            const result = await input.toolExecutor?.(call, {
              signal: options?.abortSignal ?? abortSignal,
            });
            return {
              output: result?.output ?? "",
              ...(result?.isError === true && { isError: true }),
            };
          },
        };
      } else {
        sdkTools[spec.name] = {
          type: "function" as const,
          description: spec.description,
          inputSchema: ai.jsonSchema(spec.inputSchema),
        };
      }
    }

    const streamArgs = {
      model: languageModel,
      messages: [...systemMessages, ...normalizedMessages],
      tools: sdkTools,
      toolChoice: input.toolChoice,
      maxRetries: 0,
      stopWhen: ai.stepCountIs(input.maxSteps ?? 24),
      onError: ({ error }: { error: unknown }) => {
        Bus.publish(Operational.Error, {
          traceId: input.trace?.traceId ?? crypto.randomUUID(),
          time: Date.now(),
          sessionId: sessionID,
          component: "llm.stream",
          msg: "streamText error",
          error: String(error),
        });
      },
      abortSignal: abortSignal,
      ...(input.providerOptions ?? {}),
    };
    const streamResult = ai.streamText(streamArgs as Parameters<typeof ai.streamText>[0]);

    // The ai-sdk v6 fullStream already emits text-start/text-delta/text-end
    // and reasoning-start/delta/end; only the step markers use different
    // names internally. Synthesizing text boundaries here (the old ai-v4
    // shim) duplicated the real v6 events and left an empty orphan text part
    // per block.
    async function* adaptStream(): AsyncGenerator<{
      type: string;
      [key: string]: unknown;
    }> {
      for await (const chunk of streamResult.fullStream) {
        const event = chunk as { type: string; [key: string]: unknown };

        if (event.type === "finish-step") {
          yield { ...event, type: "step-finish" };
        } else if (event.type === "start-step") {
          yield { ...event, type: "step-start" };
        } else {
          yield event;
        }
      }
    }

    return { fullStream: adaptStream() };
  };
  const traceId = input.trace?.traceId ?? crypto.randomUUID();
  const provider = model.providerID;
  const modelId = model.id;

  const processor = Processor.create({
    assistantMessage,
    sessionID,
    model,
    abort: abortSignal,
    sink,
    createStream,
    trace: {
      traceId,
      sessionId: sessionID,
      ...(input.trace?.runId !== undefined && { runId: input.trace.runId }),
      provider,
    },
  });

  Bus.publish(LlmCall.Started, {
    traceId,
    sessionId: sessionID,
    ...(input.trace?.runId !== undefined && { runId: input.trace.runId }),
    provider,
    model: modelId,
    messageCount: messages.length,
    toolCount: input.tools.length,
    time: Date.now(),
  });

  const startMs = Date.now();

  try {
    const result = await processor.process({
      messages: messages.map((m) => m.info),
      model,
      system,
    });

    const durationMs = Date.now() - startMs;
    const finalTokens = processor.message.tokens;
    const finishReason = processor.message.finish ?? "unknown";

    Bus.publish(LlmCall.Completed, {
      traceId,
      sessionId: sessionID,
      ...(input.trace?.runId !== undefined && { runId: input.trace.runId }),
      provider,
      model: modelId,
      durationMs,
      inputTokens: finalTokens.input,
      outputTokens: finalTokens.output,
      reasoningTokens: finalTokens.reasoning,
      cacheReadTokens: finalTokens.cache.read,
      cacheWriteTokens: finalTokens.cache.write,
      finishReason,
      time: Date.now(),
    });

    switch (result) {
      case "stop":
        return { type: "stop" };
      case "continue":
        return { type: "continue" };
      case "compact":
        return { type: "compact" };
      default:
        return { type: "stop" };
    }
  } catch (error) {
    if (abortSignal.aborted) {
      return { type: "aborted" };
    }

    const err = error instanceof Error ? error : new Error(String(error));
    return {
      type: "error",
      error: {
        message: err.message,
        name: err.name,
        stack: err.stack,
      },
    };
  }
}
