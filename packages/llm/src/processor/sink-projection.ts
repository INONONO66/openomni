import { Operational, type Run, type Sink, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { generateId } from "./contracts.js";

export interface ProjectedSink extends Sink {
  flush(): Promise<void>;
}

export function createProjectedSink(sink: Sink, sessionID: string): ProjectedSink {
  function publish(message: string, data?: Record<string, unknown>): void {
    if (!sessionID) return;
    Bus.publish(Operational.Info, {
      traceId: sessionID,
      time: Date.now(),
      sessionId: sessionID,
      component: "llm.processor",
      msg: message,
      context: data,
    });
  }

  return {
    onMessage(message) {
      sink.onMessage(message);
      publish("sink.message", {
        role: message.info.role,
        messageId: message.info.id,
        partCount: message.parts.length,
      });
    },

    onToolCall(call: Tool.Call) {
      sink.onToolCall(call);
      publish("sink.tool.started", {
        toolCallId: call.id,
        toolName: call.tool,
        inputSummary: summarizeRecord(call.input),
      });
    },

    onToolResult(result: Tool.Result) {
      sink.onToolResult(result);
      publish("sink.tool.completed", {
        toolCallId: result.toolCallId,
        outputLength: result.output.length,
        isError: result.isError,
      });
    },

    onSnapshot(snapshot: Run.Snapshot) {
      sink.onSnapshot(snapshot);
      publish("sink.snapshot", { stateType: String(snapshot.state.type ?? "unknown") });
    },

    flush() {
      return Promise.resolve();
    },
  };
}

export function createNoopSink(): Sink {
  return {
    onMessage: () => void 0,
    onToolCall: () => void 0,
    onToolResult: () => void 0,
    onSnapshot: () => void 0,
  };
}

export function publishStatus(sink: Sink, sessionID: string, state: Record<string, unknown>): void {
  sink.onSnapshot({
    id: generateId(),
    sessionID,
    timestamp: Date.now(),
    state,
  });
}

function summarizeRecord(input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  return keys.length === 0 ? "empty" : keys.join(",");
}
