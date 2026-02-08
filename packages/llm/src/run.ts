import type {
  Sink,
  Message,
  ToolSpec,
  RunOutcome,
  ToolCall,
} from "@openomni/protocol";
import { Processor } from "./session/processor";
import { Provider } from "./provider";

/**
 * Input for the run() function
 */
export interface RunInput {
  messages: Message.WithParts[];
  tools: ToolSpec[];
  system?: string;
  signal?: AbortSignal;
}

export async function run(input: RunInput, sink: Sink): Promise<RunOutcome> {
  const { messages, system = "", signal } = input;

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
    modelID: "default",
    providerID: "default",
    agent: "default",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };

  const pendingToolCalls: ToolCall[] = [];

  const wrappedSink: Sink = {
    onMessage: sink.onMessage,
    onToolCall: (call: ToolCall) => {
      pendingToolCalls.push(call);
      sink.onToolCall(call);
    },
    onToolResult: sink.onToolResult,
    onSnapshot: sink.onSnapshot,
  };

  const processor = Processor.create({
    assistantMessage,
    sessionID,
    model: {} as Provider.Model,
    abort: abortSignal,
    sink: wrappedSink,
  });

  try {
    const result = await processor.process({
      messages: messages.map((m) => m.info),
      model: {} as Provider.Model,
      system,
    });

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

    return {
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
