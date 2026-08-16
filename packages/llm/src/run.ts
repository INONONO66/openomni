import type { BusEvent, Sink, Message, Tool, Run } from "@openomni/protocol";
import { LlmCall, Operational } from "@openomni/protocol";
import type { SDKMessage } from "./message";
import { Processor } from "./processor";
import { toModelMessages } from "./message";
import type { Provider } from "./provider";
import { ProviderTransform } from "./provider/transform";
import { getLanguage } from "./provider/sdk";
import { Auth } from "./auth/storage";

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
  /**
   * Step-boundary yield: stop the step loop once the last finished step's
   * input tokens (the ai SDK's cache-inclusive prompt total) reach this.
   * The loop ends gracefully at a step boundary — tool pairs complete, the
   * message finishes with the model's own finishReason — so the caller can
   * compact history at its deterministic seam and re-enter. Absent = never.
   */
  yieldAtInputTokens?: number;
  providerOptions?: Record<string, unknown>;
  /**
   * The run this call belongs to. Required, and not defaulted: a model round
   * trip that cannot name its run and session produces an assistant message
   * detached from the conversation it is part of, and telemetry that
   * correlates to nothing.
   */
  trace: { traceId: string; sessionId: string; runId: string };
  /**
   * Where observation goes. See `Processor.ProcessorOptions.events` — the port exists so
   * `llm` reports what it did without reaching for a process-wide singleton.
   */
  events: BusEvent.Sink;
}

export async function run(input: RunInput, sink: Sink): Promise<Run.Outcome> {
  const { messages, system = "", signal, model } = input;

  const abortSignal = signal ?? new AbortController().signal;
  if (abortSignal.aborted) {
    return { type: "aborted" };
  }

  const { traceId, sessionId: sessionID, runId } = input.trace;
  if (traceId.length === 0 || sessionID.length === 0 || runId.length === 0) {
    throw new Error("llm run requires a non-empty traceId, sessionId, and runId");
  }
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

    // #532 cache policy: breakpoints on the last tool definition and the
    // system message (the latest-user breakpoint is placed inside
    // toModelMessages). Namespaced under `anthropic`, absent for other providers.
    const cacheOptions = ProviderTransform.anthropicCacheOptions(model);
    const systemMessages: SDKMessage[] = streamInput.system
      ? [
          {
            role: "system" as const,
            content: streamInput.system,
            ...(cacheOptions && { providerOptions: cacheOptions }),
          },
        ]
      : [];

    const sdkTools: Record<string, unknown> = {};
    for (const spec of input.tools) {
      const executor = input.toolExecutor;
      sdkTools[spec.name] = {
        type: "function" as const,
        description: spec.description,
        inputSchema: ai.jsonSchema(spec.inputSchema),
        ...(executor && {
          execute: async (
            args: Record<string, unknown>,
            options?: { toolCallId?: string; abortSignal?: AbortSignal },
          ) => {
            // The SDK always supplies toolCallId; a minted id would never
            // correlate with the stream's tool part, so refuse instead.
            if (options?.toolCallId === undefined) {
              throw new Error("tool execute called without toolCallId");
            }
            const call: Tool.Call = {
              id: options.toolCallId,
              tool: spec.name,
              input: args,
            };
            const result = await executor(call, {
              signal: options?.abortSignal ?? abortSignal,
            });
            return {
              output: result?.output ?? "",
              ...(result?.isError === true && { isError: true }),
            };
          },
        }),
      };
    }
    const lastToolName = input.tools[input.tools.length - 1]?.name;
    if (cacheOptions && lastToolName !== undefined) {
      (sdkTools[lastToolName] as Record<string, unknown>).providerOptions = cacheOptions;
    }

    const streamArgs = {
      model: languageModel,
      messages: [...systemMessages, ...normalizedMessages],
      tools: sdkTools,
      toolChoice: input.toolChoice,
      maxRetries: 0,
      stopWhen: [
        ai.stepCountIs(input.maxSteps ?? 24),
        ...(input.yieldAtInputTokens === undefined
          ? []
          : [
              ({ steps }: { steps: ReadonlyArray<{ usage?: { inputTokens?: number } }> }) =>
                (steps[steps.length - 1]?.usage?.inputTokens ?? 0) >=
                (input.yieldAtInputTokens as number),
            ]),
      ],
      onError: ({ error }: { error: unknown }) => {
        input.events.publish(Operational.Error, {
          traceId,
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
  const provider = model.providerID;
  const modelId = model.id;

  const processor = Processor.create({
    events: input.events,
    assistantMessage,
    sessionID,
    model,
    abort: abortSignal,
    sink,
    createStream,
    trace: {
      traceId,
      sessionId: sessionID,
      runId: input.trace.runId,
      provider,
    },
  });

  input.events.publish(LlmCall.Started, {
    traceId,
    sessionId: sessionID,
    runId: input.trace.runId,
    provider,
    model: modelId,
    messageCount: messages.length,
    toolCount: input.tools.length,
    time: Date.now(),
  });

  const startMs = Date.now();

  try {
    await processor.process({ system });

    const durationMs = Date.now() - startMs;
    const finalTokens = processor.message.tokens;
    const finishReason = processor.message.finish ?? "unknown";

    input.events.publish(LlmCall.Completed, {
      traceId,
      sessionId: sessionID,
      runId: input.trace.runId,
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

    return { type: "stop" };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const aborted = abortSignal.aborted;

    input.events.publish(LlmCall.Failed, {
      traceId,
      sessionId: sessionID,
      runId: input.trace.runId,
      provider,
      model: modelId,
      durationMs: Date.now() - startMs,
      error: err.message,
      aborted,
      time: Date.now(),
    });

    if (aborted) {
      return { type: "aborted" };
    }

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
