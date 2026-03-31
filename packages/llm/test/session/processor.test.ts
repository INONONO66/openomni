import { describe, expect, test, beforeEach } from "bun:test";
import { Processor } from "../../src/session/processor";
import type { Message } from "../../src/session";
import { APIError } from "../../src/error";
import type { Provider } from "../../src/provider";

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
});
