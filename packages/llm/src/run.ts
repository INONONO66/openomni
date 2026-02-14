import type { Sink, Message, Tool, Run } from "@openomni/protocol";
import type { CoreMessage } from "ai";
import { streamText, jsonSchema } from "ai";
import { Processor } from "./session/processor";
import { toModelMessages } from "./session/convert";
import { Provider, getLanguage } from "./provider";
import { Auth } from "./auth/storage";

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
  providerOptions?: Record<string, unknown>;
}

export async function run(input: RunInput, sink: Sink): Promise<Run.Outcome> {
  const { messages, system = "", signal, model } = input;

  const abortController = signal ? undefined : new AbortController();
  const abortSignal = signal || abortController!.signal;

  const sessionID =
    messages[0]?.info.sessionID ||
    `session-${Math.random().toString(36).substring(2, 11)}`;
  const messageID = `msg-${Math.random().toString(36).substring(2, 11)}`;
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

  const pendingToolCalls: Tool.Call[] = [];

  const wrappedSink: Sink = {
    onMessage: sink.onMessage,
    onToolCall: (call: Tool.Call) => {
      pendingToolCalls.push(call);
      sink.onToolCall(call);
    },
    onToolResult: sink.onToolResult,
    onSnapshot: sink.onSnapshot,
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

      const systemMessages: CoreMessage[] = streamInput.system
        ? [{ role: "system" as const, content: streamInput.system }]
        : [];

      const sdkTools: Record<
        string,
        { description?: string; parameters: unknown }
      > = {};
      for (const spec of input.tools) {
        sdkTools[spec.name] = {
          description: spec.description,
          parameters: jsonSchema(spec.inputSchema),
        };
      }

      const streamResult = streamText({
        model: languageModel,
        messages: [...systemMessages, ...normalizedMessages],
        tools: sdkTools as Parameters<typeof streamText>[0]["tools"],
        abortSignal: abortSignal,
        ...(input.providerOptions ?? {}),
      });

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
    sink: wrappedSink,
    createStream,
  });

  try {
    const result = await processor.process({
      messages: messages.map((m) => m.info),
      model: resolvedModel,
      system,
    });

    if (pendingToolCalls.length > 0) {
      return { type: "await_tool", toolCalls: pendingToolCalls };
    }

    switch (result) {
      case "stop":
        return { type: "stop" };
      case "continue":
        return { type: "await_tool", toolCalls: pendingToolCalls };
      case "compact":
        return { type: "stop" };
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
