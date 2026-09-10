import type { Message } from "@openomni/protocol";
import type { Run, RunInput } from "@openomni/llm";
import type { Sink } from "@openomni/llm";
import type { ChatAgentConfig } from "../../src/core/types";
import type { SessionRunner, SessionRunnerInput, SessionRuntime } from "../../src/session-handle";
import { createSessionChatRunner } from "../../src/session-chat-runner";
import { createTurnDispatcher } from "../../src/tool-dispatcher";
import type { AnyToolDefinition } from "@openomni/protocol";
import { createAssistantMessage } from "../../src/core/message-factory";
import { collector } from "./observation-collector";

type ModelStep = (input: RunInput, sink: Sink, turn: SessionRunnerInput) => Promise<Run.Outcome>;

/**
 * A session runner whose every turn runs the chat loop over a turn dispatcher for `definitions`;
 * `model` supplies each provider step. `runtime` is read per turn so tests may swap it.
 */
export function dispatchingRunner(
  definitions: readonly AnyToolDefinition[],
  runtime: () => SessionRuntime,
  model: ModelStep,
  extraConfig: (turn: SessionRunnerInput) => Partial<ChatAgentConfig> = () => ({}),
): SessionRunner {
  return createSessionChatRunner({
    prepare(input) {
      const dispatcher = createTurnDispatcher(definitions, input, runtime());
      return {
        traceContext: { traceId: "trace", sessionId: input.sessionId, runId: input.resultId },
        config: {
          events: collector(),
          executor: dispatcher.executor,
          model: { provider: "test", id: "test" },
          tools: [...dispatcher.specs],
          toolWave: (calls, signal) =>
            dispatcher.executeWave(calls, {
              sessionId: input.sessionId,
              turnId: input.turnId,
              signal,
            }),
          toolExecutor: (call) =>
            dispatcher.execute(call, { sessionId: input.sessionId, turnId: input.turnId }),
          llm: {
            resolveModel: async () => ({ providerID: "test", id: "test", name: "test" }),
            run: (request, sink) => model(request, sink, input),
          },
          ...extraConfig(input),
        },
      };
    },
  });
}

/** An assistant message for `sessionId` that optionally requests one pending tool call. */
export function assistantStep(
  text: string,
  sessionId: string,
  parentId: string,
  toolCall?: { id: string; callID: string; tool: string },
): Message.WithParts {
  const message = createAssistantMessage(text, parentId, sessionId);
  if (toolCall !== undefined)
    message.parts.push({
      id: toolCall.id,
      messageID: message.info.id,
      sessionID: sessionId,
      type: "tool",
      callID: toolCall.callID,
      tool: toolCall.tool,
      state: { status: "pending", input: {} },
    });
  return message;
}
