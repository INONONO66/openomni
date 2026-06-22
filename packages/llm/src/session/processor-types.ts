import type { Message, Sink } from "@openomni/protocol";
import type { Provider } from "../provider";

export type ProcessResult = "stop" | "continue" | "compact";

export interface ToolResult {
  output: string;
  title: string;
  metadata?: Record<string, unknown>;
  isError?: boolean;
}

export interface StreamInput {
  messages: unknown[];
  model: Provider.Model;
  system: string;
}

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface Stream {
  fullStream: AsyncIterable<StreamEvent>;
}

export interface ProcessorOptions {
  assistantMessage: Message.AssistantMessage;
  sessionID: string;
  model: Provider.Model;
  abort: AbortSignal;
  maxRetryAttempts?: number;
  sink?: Sink;
  onToolCall?: (part: Message.ToolPart) => Promise<ToolResult>;
  createStream?: (input: StreamInput) => Promise<Stream>;
  trace?: { traceId: string; sessionId: string; runId?: string; provider?: string };
}

export interface ProcessorInfo {
  message: Message.AssistantMessage;
  process(streamInput: StreamInput): Promise<ProcessResult>;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function defaultStream(_input: StreamInput): Promise<Stream> {
  return Promise.resolve({
    fullStream: (async function* () {
      yield { type: "finish" };
    })(),
  });
}
