import { beforeEach, mock } from "bun:test";
import type { PlainObject } from "@openomni/protocol";
import type { ModelMessage, ToolSet } from "ai";
import { run, type RunInput } from "../../src/run";
import type { StreamEvent } from "../../src/processor/stream-events";
import type { Sink } from "../../src/sink";
import { collector } from "./observation";

export type Condition = (input: { steps: Array<{ usage?: { inputTokens?: number } }> }) => boolean;
interface Arguments {
  messages: ModelMessage[];
  tools: ToolSet;
  toolChoice?: string;
  maxRetries: number;
  stopWhen: Condition[];
  providerOptions?: PlainObject;
  abortSignal: AbortSignal;
  onError: (payload: { error: Error }) => void;
}

export function useStreamCapture() {
  let args: Arguments | undefined;
  let stepCount: number | undefined;
  let chunks: StreamEvent[];
  const sink: Sink = {
    onMessage: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
  };
  const events = collector();
  beforeEach(() => {
    args = undefined;
    stepCount = undefined;
    chunks = [{ type: "finish" }];
    events.reset();
    mock.module("ai", () => ({
      streamText: (input: Arguments) => {
        args = input;
        return {
          fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
            yield* chunks;
          })(),
        };
      },
      jsonSchema: (schema: PlainObject) => ({ jsonSchema: schema }),
      stepCountIs: (count: number): Condition => {
        stepCount = count;
        return ({ steps }) => steps.length === count;
      },
    }));
  });
  return {
    events,
    get args() {
      if (args === undefined) throw new Error("streamText was not called");
      return args;
    },
    condition(index: number): Condition {
      const condition = args?.stopWhen[index];
      if (condition === undefined) throw new Error(`Missing stop condition ${index}`);
      return condition;
    },
    get stepCount() {
      return stepCount;
    },
    stream(events: StreamEvent[]) {
      chunks = events;
    },
    run(overrides: Partial<RunInput> = {}, output: Sink = sink) {
      return run(
        {
          trace: {
            traceId: "trace-stream-capture",
            sessionId: "session-stream-capture",
            runId: "run-stream-capture",
          },
          events,
          messages: [],
          tools: [],
          auth: { type: "api", key: "test-key-stream-capture" },
          model: {
            id: "claude-3-haiku",
            providerID: "__test_stream_capture__",
            name: "test",
            api: { npm: "@ai-sdk/anthropic" },
          },
          ...overrides,
        },
        output,
      );
    },
  };
}
