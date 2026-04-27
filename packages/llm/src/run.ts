import type { Sink, Message, Tool, Run } from "@openomni/protocol";
import { LlmCall } from "@openomni/protocol";
import { streamText, jsonSchema } from "ai";
import type { SDKMessage } from "./session/convert";
import { Processor } from "./session/processor";
import { toModelMessages } from "./session/convert";
import { type Provider, getLanguage } from "./provider";
import { Auth } from "./auth/storage";
import { Bus, Log } from "@openomni/session";

/**
 * Input for the run() function.
 *
 * When `model` is provided the function resolves auth credentials
 * and calls the real provider SDK.  When omitted the Processor
 * falls back to its default noop stream (useful for unit tests).
 */
export interface RunInput {
  messages: Message.WithParts[];
  tools: Tool.Spec[];
  system?: string;
  signal?: AbortSignal;
  model?: Provider.Model;
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  toolChoice?: "auto" | "required" | "none";
  maxSteps?: number;
  providerOptions?: Record<string, unknown>;
  trace?: { traceId?: string };
}

export async function run(input: RunInput, sink: Sink): Promise<Run.Outcome> {
  const { messages, system = "", signal, model } = input;

  const abortController = signal ? null : new AbortController();
  const abortSignal = signal ?? abortController?.signal;
  if (!abortSignal) {
    throw new Error("Failed to initialize abort signal");
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
    modelID: model?.id ?? "default",
    providerID: model?.providerID ?? "default",
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

  let createStream: Processor.ProcessorOptions["createStream"];

  if (model) {
    createStream = async (streamInput) => {
      const auth = await Auth.get(model.providerID);
      if (!auth) {
        throw new Error(
          `No authentication found for provider: ${model.providerID}. Run 'openomni auth login' first.`,
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
            inputSchema: jsonSchema(spec.inputSchema),
            execute: async (args: Record<string, unknown>) => {
              const call: Tool.Call = {
                id: crypto.randomUUID(),
                tool: spec.name,
                input: args,
              };
              const result = await input.toolExecutor?.(call);
              if (!result) return "";
              sink.onToolCall(call);
              sink.onToolResult(result);
              if (result.isError) return `Error: ${result.output}`;
              return result.output;
            },
          };
        } else {
          sdkTools[spec.name] = {
            type: "function" as const,
            description: spec.description,
            inputSchema: jsonSchema(spec.inputSchema),
          };
        }
      }

      const streamArgs = {
        model: languageModel,
        messages: [...systemMessages, ...normalizedMessages],
        tools: sdkTools,
        toolChoice: input.toolChoice,
        maxRetries: 0,
        stopWhen: ({ steps }: { steps: unknown[] }) => steps.length >= (input.maxSteps ?? 24),
        onError: ({ error }: { error: unknown }) => {
          Log.error("streamText error", { error: String(error) });
        },
        abortSignal: abortSignal,
        ...(input.providerOptions ?? {}),
      };
      const streamResult = streamText(streamArgs as unknown as Parameters<typeof streamText>[0]);

      async function* adaptStream(): AsyncGenerator<{
        type: string;
        [key: string]: unknown;
      }> {
        let inText = false;

        for await (const chunk of streamResult.fullStream) {
          const event = chunk as { type: string; [key: string]: unknown };

          if (event.type === "text-delta" && !inText) {
            inText = true;
            yield { type: "text-start" };
          }

          if (event.type !== "text-delta" && inText) {
            inText = false;
            yield { type: "text-end" };
          }

          if (event.type === "text-delta") {
            yield { ...event, text: event.textDelta ?? event.text };
          } else if (event.type === "reasoning") {
            yield {
              ...event,
              type: "reasoning-delta",
              text: event.textDelta ?? event.text,
            };
          } else if (event.type === "finish-step") {
            yield { ...event, type: "step-finish" };
          } else if (event.type === "start-step") {
            yield { ...event, type: "step-start" };
          } else {
            yield event;
          }
        }

        if (inText) {
          yield { type: "text-end" };
        }
      }

      return { fullStream: adaptStream() };
    };
  }

  const resolvedModel = model ?? ({} as Provider.Model);

  const processor = Processor.create({
    assistantMessage,
    sessionID,
    model: resolvedModel,
    abort: abortSignal,
    sink,
    createStream,
  });

  const traceId = input.trace?.traceId ?? crypto.randomUUID();
  const provider = model?.providerID ?? "default";
  const modelId = model?.id ?? "default";

  Log.info("llm call starting", {
    model: modelId,
    provider,
    messageCount: messages.length,
    toolCount: input.tools.length,
    traceId,
    sessionId: sessionID,
  });

  Bus.publish(LlmCall.Started, {
    traceId,
    sessionId: sessionID,
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
      model: resolvedModel,
      system,
    });

    const durationMs = Date.now() - startMs;
    const finalTokens = processor.message.tokens;
    const finishReason = processor.message.finish ?? "unknown";

    Log.info("llm call completed", {
      model: modelId,
      provider,
      durationMs,
      inputTokens: finalTokens.input,
      outputTokens: finalTokens.output,
      finishReason,
      traceId,
      sessionId: sessionID,
    });

    Bus.publish(LlmCall.Completed, {
      traceId,
      sessionId: sessionID,
      provider,
      model: modelId,
      durationMs,
      inputTokens: finalTokens.input,
      outputTokens: finalTokens.output,
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
