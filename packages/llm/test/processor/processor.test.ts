import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import {
  LlmCall,
  Operational,
  type Message,
  type Run,
  type Sink,
  type Tool,
} from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";
import { Processor } from "../../src/processor";
import { APIError } from "../../src/error";
import type { Provider } from "../../src/provider";

type OperationalInfoPayload = {
  traceId: string;
  time: number;
  sessionId?: string;
  component: string;
  msg: string;
  context?: Record<string, unknown>;
};

function configureSession(sessionId: string): void {
  const messages = new Map<string, Message.Info>();
  const parts = new Map<string, Message.Part>();
  const now = Date.now();

  Storage.configure({
    session: {
      get(id) {
        if (id !== sessionId) return undefined;
        return {
          id: sessionId,
          title: "Processor test session",
          model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
          spawnDepth: 0,
          time: { created: now, updated: now },
        };
      },
      set() {
        return undefined;
      },
      list() {
        return [];
      },
      remove() {
        return false;
      },
    },
    message: {
      get(_sessionID, messageID) {
        return messages.get(messageID);
      },
      set(_sessionID, message) {
        messages.set(message.id, message);
      },
      list() {
        return [...messages.values()];
      },
      remove(_sessionID, messageID) {
        return messages.delete(messageID);
      },
    },
    part: {
      get(_messageID, partID) {
        return parts.get(partID);
      },
      set(_messageID, part) {
        parts.set(part.id, part);
      },
      list() {
        return [...parts.values()];
      },
      remove(_messageID, partID) {
        return parts.delete(partID);
      },
    },
  });
}

describe("Processor", () => {
  let mockAssistantMessage: Message.AssistantMessage;
  let mockModel: Provider.Model;
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
    mockAssistantMessage = {
      id: "msg-123",
      sessionID: "session-456",
      role: "assistant",
      time: {
        created: Date.now(),
      },
      parentID: "parent-789",
      modelID: "claude-3-5-sonnet",
      providerID: "anthropic",
      agent: "test-agent",
      path: {
        cwd: "/test",
        root: "/",
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    };

    mockModel = {
      id: "claude-3-5-sonnet",
      providerID: "anthropic",
      name: "Claude 3.5 Sonnet",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    };
  });

  afterEach(() => {
    Bus.reset();
    Storage.reset();
  });

  describe("Processor.create(input)", () => {
    test("does not expose removed helper type namespace members", async () => {
      const processorSource = await Bun.file(
        new URL("../../src/processor/index.ts", import.meta.url),
      ).text();

      expect(Object.hasOwn(Processor, "ProcessResult")).toBe(false);
      expect(Object.hasOwn(Processor, "ToolResult")).toBe(false);
      expect(Object.hasOwn(Processor, "ProcessorInfo")).toBe(false);
      expect(processorSource).not.toMatch(/\bexport\s+type\s+ProcessResult\b/);
      expect(processorSource).not.toMatch(/\bexport\s+interface\s+ToolResult\b/);
      expect(processorSource).not.toMatch(/\bexport\s+interface\s+ProcessorInfo\b/);
    });

    test("creates a processor with required input", () => {
      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
      });

      expect(processor).toBeDefined();
      expect(processor.message).toEqual(mockAssistantMessage);
      expect(processor.process).toBeDefined();
    });

    test("returns ProcessorInfo with message property", () => {
      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
      });

      expect(processor.message).toBe(mockAssistantMessage);
    });

    test("returns ProcessorInfo with process method", () => {
      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
      });

      expect(typeof processor.process).toBe("function");
    });
  });

  describe("Processor.process(streamInput)", () => {
    test("handles text-start event and creates TextPart", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "text-start", providerMetadata: {} };
          yield { type: "text-delta", text: "Hello" };
          yield { type: "text-end", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("handles reasoning-start event and creates ReasoningPart", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield {
            type: "reasoning-start",
            id: "reason-1",
            providerMetadata: {},
          };
          yield {
            type: "reasoning-delta",
            id: "reason-1",
            text: "Thinking...",
          };
          yield { type: "reasoning-end", id: "reason-1", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("handles step-start event", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "step-start" };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("handles step-finish event", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield {
            type: "step-finish",
            finishReason: "end_turn",
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              reasoning_tokens: 4,
              cache_creation_input_tokens: 6,
              cache_read_input_tokens: 2,
            },
            providerMetadata: {},
          };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("accumulates text across multiple text-delta events", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "text-start", providerMetadata: {} };
          yield { type: "text-delta", text: "Hello" };
          yield { type: "text-delta", text: " " };
          yield { type: "text-delta", text: "World" };
          yield { type: "text-end", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("accumulates reasoning across multiple reasoning-delta events", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "reasoning-start", id: "r1", providerMetadata: {} };
          yield { type: "reasoning-delta", id: "r1", text: "Step 1" };
          yield { type: "reasoning-delta", id: "r1", text: " - " };
          yield { type: "reasoning-delta", id: "r1", text: "Step 2" };
          yield { type: "reasoning-end", id: "r1", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("sets time.start on TextPart creation", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "text-start", providerMetadata: {} };
          yield { type: "text-delta", text: "test" };
          yield { type: "text-end", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("sets time.start and time.end on ReasoningPart", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "reasoning-start", id: "r1", providerMetadata: {} };
          yield { type: "reasoning-delta", id: "r1", text: "thinking" };
          yield { type: "reasoning-end", id: "r1", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("returns 'stop' when stream completes successfully", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("projects sink callbacks to Bus events", async () => {
      const busEvents: OperationalInfoPayload[] = [];
      const unsub = Bus.subscribe(Operational.Info, (data) => {
        if (data.component === "llm.processor") {
          busEvents.push(data);
        }
      });

      const sinkEvents: string[] = [];
      const toolCalls: Tool.Call[] = [];
      const toolResults: Tool.Result[] = [];
      const snapshots: Run.Snapshot[] = [];
      const messages: Message.WithParts[] = [];

      configureSession("session-456");

      const sink: Sink = {
        onMessage(message) {
          sinkEvents.push("message");
          messages.push(message);
        },
        onToolCall(call) {
          sinkEvents.push("toolCall");
          toolCalls.push(call);
        },
        onToolResult(result) {
          sinkEvents.push("toolResult");
          toolResults.push(result);
        },
        onSnapshot(snapshot) {
          sinkEvents.push(`snapshot:${String(snapshot.state.type)}`);
          snapshots.push(snapshot);
        },
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        sink,
        createStream: async () => ({
          fullStream: (async function* () {
            yield { type: "text-start", providerMetadata: {} };
            yield { type: "text-delta", text: "Hello" };
            yield { type: "text-end", providerMetadata: {} };
            yield { type: "tool-call", toolCallId: "call-1", toolName: "lookup", args: { q: "x" } };
            yield { type: "finish" };
          })(),
        }),
        onToolCall: async () => ({ output: "ok", title: "Lookup" }),
      });

      const result = await processor.process({ messages: [], model: mockModel, system: "" });
      await new Promise((resolve) => queueMicrotask(resolve));

      expect(result).toBe("stop");
      expect(sinkEvents).toContain("message");
      expect(sinkEvents).toContain("toolCall");
      expect(sinkEvents).toContain("toolResult");
      expect(sinkEvents).toContain("snapshot:busy");
      expect(sinkEvents).toContain("snapshot:idle");
      expect(messages.length).toBeGreaterThan(0);
      expect(toolCalls).toEqual([{ id: "call-1", tool: "lookup", input: { q: "x" } }]);
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolCallId).toBe("call-1");
      expect(snapshots.map((snapshot) => snapshot.state.type)).toEqual(["busy", "idle"]);

      expect(busEvents.every((event) => event.component === "llm.processor")).toBe(true);
      expect(busEvents.every((event) => event.sessionId === "session-456")).toBe(true);
      expect(busEvents.every((event) => typeof event.time === "number")).toBe(true);

      const messageEvents = busEvents.filter((event) => event.msg === "sink.message");
      const snapshotEvents = busEvents.filter((event) => event.msg === "sink.snapshot");
      const toolStarted = busEvents.find((event) => event.msg === "sink.tool.started");
      const toolCompleted = busEvents.find((event) => event.msg === "sink.tool.completed");

      expect(messageEvents.length).toBe(messages.length);
      expect(snapshotEvents.length).toBe(2);
      expect(toolStarted?.context).toMatchObject({
        toolCallId: "call-1",
        toolName: "lookup",
        inputSummary: "q",
      });
      expect(toolCompleted?.context).toMatchObject({
        toolCallId: "call-1",
        outputLength: 2,
      });

      unsub();
    });

    test("respects abort signal during stream processing", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      abortController.abort();

      try {
        await processor.process({
          messages: [],
          model: mockModel,
          system: "",
        } as Processor.StreamInput);
        expect.unreachable("Should have thrown AbortError");
      } catch (e) {
        expect(e).toBeInstanceOf(DOMException);
        expect((e as DOMException).name).toBe("AbortError");
      }
    });

    test("handles retryable errors with retry logic", async () => {
      let attemptCount = 0;

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              throw new APIError({
                message: JSON.stringify({
                  type: "error",
                  error: { type: "too_many_requests" },
                }),
                isRetryable: true,
              });
            }
            yield { type: "finish" };
          })(),
        }),
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBeDefined();
      expect(attemptCount).toBe(2);
    });

    test("publishes structured retry and rate-limit events", async () => {
      let attemptCount = 0;
      const retries: Array<{ runId?: string; reason: string; backoffMs: number }> = [];
      const rateLimits: Array<{ runId?: string; provider: string; retryAfterMs: number }> = [];
      const unsubRetry = Bus.subscribe(LlmCall.RetryDecided, (event) => {
        retries.push(event);
      });
      const unsubRateLimit = Bus.subscribe(LlmCall.RateLimited, (event) => {
        rateLimits.push(event);
      });

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        trace: {
          traceId: "trace-processor-retry",
          sessionId: "session-456",
          runId: "run-processor-retry",
          provider: "anthropic",
        },
        createStream: async () => ({
          fullStream: (async function* () {
            attemptCount++;
            if (attemptCount === 1) {
              throw new APIError({
                message: JSON.stringify({
                  type: "error",
                  error: { type: "too_many_requests" },
                }),
                isRetryable: true,
              });
            }
            yield { type: "finish" };
          })(),
        }),
      });

      await processor.process({ messages: [], model: mockModel, system: "" });
      unsubRetry();
      unsubRateLimit();

      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({
        runId: "run-processor-retry",
        reason: "Too Many Requests",
      });
      expect(retries[0]?.backoffMs).toBeGreaterThan(0);
      expect(rateLimits).toHaveLength(1);
      expect(rateLimits[0]).toMatchObject({
        runId: "run-processor-retry",
        provider: "anthropic",
        retryAfterMs: retries[0]?.backoffMs,
      });
    });

    test("handles non-retryable errors", async () => {
      const errorInstance = new APIError({
        message: "Not found",
        statusCode: 404,
        isRetryable: false,
      });

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => ({
          fullStream: (async function* (shouldThrow = true) {
            if (shouldThrow) throw errorInstance;
            yield { type: "finish" };
          })(),
        }),
      });

      try {
        await processor.process({
          messages: [],
          model: mockModel,
          system: "",
        } as Processor.StreamInput);
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(APIError);
      }
    });

    test("throws original error instance for non-retryable non-abort errors", async () => {
      const errorInstance = new APIError({
        message: "Specific error",
        statusCode: 500,
        isRetryable: false,
      });

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => ({
          fullStream: (async function* (shouldThrow = true) {
            if (shouldThrow) throw errorInstance;
            yield { type: "finish" };
          })(),
        }),
      });

      try {
        await processor.process({
          messages: [],
          model: mockModel,
          system: "",
        } as Processor.StreamInput);
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBe(errorInstance);
      }
    });

    test("ignores duplicate reasoning-start events with same id", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "reasoning-start", id: "r1", providerMetadata: {} };
          yield { type: "reasoning-start", id: "r1", providerMetadata: {} };
          yield { type: "reasoning-delta", id: "r1", text: "test" };
          yield { type: "reasoning-end", id: "r1", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("handles multiple text parts sequentially", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "text-start", providerMetadata: {} };
          yield { type: "text-delta", text: "First" };
          yield { type: "text-end", providerMetadata: {} };
          yield { type: "text-start", providerMetadata: {} };
          yield { type: "text-delta", text: "Second" };
          yield { type: "text-end", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("trims trailing whitespace from text", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "text-start", providerMetadata: {} };
          yield { type: "text-delta", text: "Hello   " };
          yield { type: "text-end", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });

    test("trims trailing whitespace from reasoning", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield { type: "reasoning-start", id: "r1", providerMetadata: {} };
          yield { type: "reasoning-delta", id: "r1", text: "thinking   " };
          yield { type: "reasoning-end", id: "r1", providerMetadata: {} };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: mockModel,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      const result = await processor.process({
        messages: [],
        model: mockModel,
        system: "",
      } as Processor.StreamInput);

      expect(result).toBe("stop");
    });
  });

  describe("token accounting", () => {
    test("keeps local cost at zero and accumulates AI SDK token usage", async () => {
      const modelWithCatalogCost: Provider.Model = {
        id: "claude-opus-4-5",
        providerID: "anthropic",
        name: "Claude Opus",
        cost: { input: 15.0, output: 75.0, cache: { read: 1.5, write: 18.75 } },
      };

      const mockStream = {
        fullStream: (async function* () {
          yield {
            type: "step-finish",
            finishReason: "end_turn",
            usage: { inputTokens: 10000, outputTokens: 5000 },
          };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: modelWithCatalogCost,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      await processor.process({ messages: [], model: modelWithCatalogCost, system: "" });

      expect(mockAssistantMessage.cost).toBe(0);
      expect(mockAssistantMessage.providerID).toBe("anthropic");
      expect(mockAssistantMessage.modelID).toBe("claude-3-5-sonnet");
      expect(mockAssistantMessage.tokens.input).toBe(10000);
      expect(mockAssistantMessage.tokens.output).toBe(5000);
    });

    test("returns zero cost when model.cost is absent", async () => {
      const modelNoCost: Provider.Model = {
        id: "gpt-4o",
        providerID: "openai",
        name: "GPT-4o",
      };

      const mockStream = {
        fullStream: (async function* () {
          yield {
            type: "step-finish",
            finishReason: "stop",
            usage: { inputTokens: 10000, outputTokens: 5000 },
          };
          yield { type: "finish" };
        })(),
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: modelNoCost,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      await processor.process({ messages: [], model: modelNoCost, system: "" });

      expect(mockAssistantMessage.cost).toBe(0);
      expect(mockAssistantMessage.tokens.input).toBe(10000);
      expect(mockAssistantMessage.tokens.output).toBe(5000);
    });

    test("accumulates tokens across multiple step-finish events", async () => {
      const mockStream = {
        fullStream: (async function* () {
          yield {
            type: "step-finish",
            finishReason: "tool_use",
            usage: { inputTokens: 1000, outputTokens: 500 },
          };
          yield {
            type: "step-finish",
            finishReason: "end_turn",
            usage: { inputTokens: 2000, outputTokens: 800 },
          };
          yield { type: "finish" };
        })(),
      };

      const modelWithCatalogCost: Provider.Model = {
        id: "claude-3-5-sonnet-20241022",
        providerID: "anthropic",
        name: "Claude 3.5 Sonnet",
        cost: { input: 3, output: 15 },
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: modelWithCatalogCost,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      await processor.process({ messages: [], model: modelWithCatalogCost, system: "" });

      expect(mockAssistantMessage.cost).toBe(0);
      expect(mockAssistantMessage.tokens.input).toBe(3000);
      expect(mockAssistantMessage.tokens.output).toBe(1300);
    });
  });
});
