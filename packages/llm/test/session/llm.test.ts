import { describe, expect, test, beforeEach } from "bun:test";
import { Stream } from "../../src/session/llm";
import { Message } from "../../src/session";
import { Provider } from "../../src/provider";

describe("Stream", () => {
  let mockModel: Provider.Model;
  let mockMessages: Message.Info[];
  let mockAbortController: AbortController;

  beforeEach(() => {
    mockModel = {
      id: "claude-3-5-sonnet",
      providerID: "anthropic",
      name: "Claude 3.5 Sonnet",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    };

    mockMessages = [
      {
        id: "msg-1",
        sessionID: "session-1",
        role: "user",
        time: { created: 1000 },
        agent: "default",
        model: {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
        },
      } as Message.UserMessage,
    ];

    mockAbortController = new AbortController();
  });

  describe("stream()", () => {
    test("accepts StreamInput with required fields", () => {
      const input: Stream.StreamInput = {
        model: mockModel,
        messages: mockMessages,
        abort: mockAbortController.signal,
      };

      expect(input).toBeDefined();
      expect(input.model).toBe(mockModel);
      expect(input.messages).toBe(mockMessages);
      expect(input.abort).toBe(mockAbortController.signal);
    });

    test("accepts StreamInput with optional system prompt", () => {
      const input: Stream.StreamInput = {
        model: mockModel,
        messages: mockMessages,
        system: "You are a helpful assistant",
        abort: mockAbortController.signal,
      };

      expect(input.system).toBe("You are a helpful assistant");
    });

    test("accepts StreamInput with optional options", () => {
      const input: Stream.StreamInput = {
        model: mockModel,
        messages: mockMessages,
        abort: mockAbortController.signal,
        options: {
          temperature: 0.7,
          maxTokens: 1000,
        },
      };

      expect(input.options).toBeDefined();
      expect(input.options?.temperature).toBe(0.7);
      expect(input.options?.maxTokens).toBe(1000);
    });

    test("stream function exists and is callable", () => {
      expect(typeof Stream.stream).toBe("function");
    });

    test("stream returns a promise", () => {
      const input: Stream.StreamInput = {
        model: mockModel,
        messages: mockMessages,
        abort: mockAbortController.signal,
      };

      const result = Stream.stream(input);
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe("generate()", () => {
    test("accepts GenerateInput with required fields", () => {
      const input: Stream.GenerateInput = {
        model: mockModel,
        messages: mockMessages,
        abort: mockAbortController.signal,
      };

      expect(input).toBeDefined();
      expect(input.model).toBe(mockModel);
      expect(input.messages).toBe(mockMessages);
      expect(input.abort).toBe(mockAbortController.signal);
    });

    test("accepts GenerateInput with optional system prompt", () => {
      const input: Stream.GenerateInput = {
        model: mockModel,
        messages: mockMessages,
        system: "You are a helpful assistant",
        abort: mockAbortController.signal,
      };

      expect(input.system).toBe("You are a helpful assistant");
    });

    test("accepts GenerateInput with optional options", () => {
      const input: Stream.GenerateInput = {
        model: mockModel,
        messages: mockMessages,
        abort: mockAbortController.signal,
        options: {
          temperature: 0.5,
          maxTokens: 500,
        },
      };

      expect(input.options).toBeDefined();
      expect(input.options?.temperature).toBe(0.5);
      expect(input.options?.maxTokens).toBe(500);
    });

    test("generate function exists and is callable", () => {
      expect(typeof Stream.generate).toBe("function");
    });

    test("generate returns a promise", () => {
      const input: Stream.GenerateInput = {
        model: mockModel,
        messages: mockMessages,
        abort: mockAbortController.signal,
      };

      const result = Stream.generate(input);
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe("Stream namespace", () => {
    test("exports StreamInput type", () => {
      const input: Stream.StreamInput = {
        model: mockModel,
        messages: mockMessages,
        abort: mockAbortController.signal,
      };
      expect(input).toBeDefined();
    });

    test("exports GenerateInput type", () => {
      const input: Stream.GenerateInput = {
        model: mockModel,
        messages: mockMessages,
        abort: mockAbortController.signal,
      };
      expect(input).toBeDefined();
    });

    test("exports stream function", () => {
      expect(Stream.stream).toBeDefined();
    });

    test("exports generate function", () => {
      expect(Stream.generate).toBeDefined();
    });
  });
});
