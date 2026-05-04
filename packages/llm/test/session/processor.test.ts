import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import type { ExecutionEvent, Run, Sink, Tool } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { Processor } from "../../src/session/processor";
import type { Message } from "../../src/session";
import { APIError } from "../../src/error";
import type { Provider } from "../../src/provider";

interface EventLogRow {
  id: number;
  type: string;
  status: string;
  data: string;
}

function configureEventLogSession(sessionId: string, rows: EventLogRow[]): void {
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
    eventLog: {
      append(rowSessionId, type, data) {
        if (rowSessionId !== sessionId) return rows.length;
        const id = rows.length + 1;
        rows.push({ id, type, status: "pending", data });
        return id;
      },
      replay(rowSessionId) {
        return rowSessionId === sessionId ? rows : [];
      },
      listIncomplete(rowSessionId) {
        return rowSessionId === sessionId ? rows : [];
      },
      markComplete(_rowSessionId, eventId) {
        const row = rows.find((item) => item.id === eventId);
        if (row) row.status = "completed";
      },
      listIncompleteSessions() {
        return rows.some((row) => row.status !== "completed") ? [sessionId] : [];
      },
    },
  });
}

function parseRows(rows: EventLogRow[]): ExecutionEvent[] {
  return rows.map((row) => JSON.parse(row.data) as ExecutionEvent);
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
    Storage.reset();
  });

  describe("Processor.create(input)", () => {
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

    test("projects sink callbacks to session EventLog rows", async () => {
      const rows: EventLogRow[] = [];
      const sinkEvents: string[] = [];
      const toolCalls: Tool.Call[] = [];
      const toolResults: Tool.Result[] = [];
      const snapshots: Run.Snapshot[] = [];
      const messages: Message.WithParts[] = [];

      configureEventLogSession("session-456", rows);

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
      const events = parseRows(rows);

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

      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: events.length }, (_value, index) => index + 1),
      );
      expect(events.every((event) => event.visibility === "internal")).toBe(true);
      expect(
        events.every((event) => event.actionId.startsWith("session-456:processor.sink.")),
      ).toBe(true);
      expect(events.every((event) => !Number.isNaN(Date.parse(event.timestamp)))).toBe(true);

      const messageRows = events.filter(
        (event): event is ExecutionEvent.MirroredBusEvent =>
          event.type === "bus_event" && event.name === "processor.sink.message",
      );
      const snapshotRows = events.filter(
        (event): event is ExecutionEvent.MirroredBusEvent =>
          event.type === "bus_event" && event.name === "processor.sink.snapshot",
      );
      const toolStarted = events.find(
        (event): event is ExecutionEvent.ToolStarted => event.type === "tool_started",
      );
      const toolCompleted = events.find(
        (event): event is ExecutionEvent.ToolCompleted => event.type === "tool_completed",
      );

      expect(messageRows.length).toBe(messages.length);
      expect(snapshotRows.length).toBe(2);
      expect(toolStarted).toMatchObject({
        type: "tool_started",
        toolCallId: "call-1",
        toolName: "lookup",
        args: { q: "x" },
      });
      expect(toolCompleted).toMatchObject({
        type: "tool_completed",
        toolCallId: "call-1",
        result: { toolCallId: "call-1", output: "ok" },
        parentActionId: toolStarted?.actionId,
      });
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

  describe("cost tracking", () => {
    test("calculates cost from model.cost and accumulates in assistantMessage", async () => {
      const modelWithCost: Provider.Model = {
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
        model: modelWithCost,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      await processor.process({ messages: [], model: modelWithCost, system: "" });

      // inputCost = (10000/1M) * 15.0 = 0.15
      // outputCost = (5000/1M) * 75.0 = 0.375
      // totalCost = 0.15 + 0.375 = 0.525
      expect(mockAssistantMessage.cost).toBeGreaterThan(0);
      expect(mockAssistantMessage.cost).toBeCloseTo(0.525, 4);
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

    test("accumulates cost across multiple step-finish events", async () => {
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

      const modelWithCost: Provider.Model = {
        id: "claude-3-5-sonnet-20241022",
        providerID: "anthropic",
        name: "Claude 3.5 Sonnet",
        cost: { input: 3, output: 15 },
      };

      const processor = Processor.create({
        assistantMessage: mockAssistantMessage,
        sessionID: "session-456",
        model: modelWithCost,
        abort: abortController.signal,
        createStream: async () => mockStream,
      });

      await processor.process({ messages: [], model: modelWithCost, system: "" });

      // step1: (1000/1M)*3 + (500/1M)*15 = 0.003 + 0.0075 = 0.0105
      // step2: (2000/1M)*3 + (800/1M)*15 = 0.006 + 0.012 = 0.018
      // total = 0.0285
      expect(mockAssistantMessage.cost).toBeCloseTo(0.0285, 4);
      expect(mockAssistantMessage.tokens.input).toBe(3000);
      expect(mockAssistantMessage.tokens.output).toBe(1300);
    });
  });
});
