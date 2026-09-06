import { describe, expect, it, mock, spyOn } from "bun:test";
import { Auth } from "@openomni/llm";
import type { Tool } from "@openomni/protocol";
import { createAssistantMessage } from "../src/core/message-factory";
import { RunEvents } from "../src/core/execution/events";
import { ChatAgent } from "../src/core/chat-agent";
import { Bus } from "../src/index";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "./helpers/mock-llm";
import { runInput } from "./helpers/run-input";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };
function agent(run: MockLlmFn) {
  return ChatAgent.create({
    events: Bus,
    model,
    llm: createMockLlmConfig({
      getModels: async () => mockProviderData,
      fromModelsDevModel: () => mockProviderModel,
      run,
    }),
  });
}

describe("ChatAgent public run contract", () => {
  it("returns terminal text, step, and token usage", async () => {
    const result = await agent(async (_input, sink) => {
      const message = createAssistantMessage("answer", "", "session");
      if (message.info.role !== "assistant") throw new Error("expected assistant message");
      sink.onMessage({
        ...message,
        info: {
          ...message.info,
          tokens: { input: 8, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      return createStopOutcome();
    }).run(runInput([{ role: "user", content: "hello" }]));
    expect(result).toMatchObject({
      text: "answer",
      steps: [{ type: "text", content: "answer" }],
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
      finishReason: "stop",
    });
  });

  it("forwards provider options, auth, transport, and tool choice", async () => {
    let observed: Parameters<MockLlmFn>[0] | undefined;
    const transport = { baseURL: "https://proxy.test", headers: { "x-route": "test" } };
    const controller = new AbortController();
    await ChatAgent.create({
      events: Bus,
      model,
      auth: { type: "api", key: "secret" },
      signal: controller.signal,
      transport,
      providerOptions: { temperature: 0 },
      toolChoice: "none",
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async (input) => {
          observed = input;
          return createStopOutcome();
        },
      }),
    }).run(runInput([{ role: "user", content: "hello" }]));
    expect(observed).toMatchObject({
      auth: { type: "api", key: "secret" },
      signal: controller.signal,
      transport,
      providerOptions: { temperature: 0 },
      toolChoice: "none",
      maxRetryAttempts: 0,
    });
  });

  it("invokes onStepFinish with the exact returned step", async () => {
    const seen: Array<{ type: "text"; content: string }> = [];
    const result = await ChatAgent.create({
      events: Bus,
      model,
      onStepFinish: (step) => {
        seen.push(step);
      },
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async (_input, sink) => {
          sink.onMessage(createAssistantMessage("done", "", "session"));
          return createStopOutcome();
        },
      }),
    }).run(runInput([{ role: "user", content: "hello" }]));
    expect(seen).toEqual(result.steps);
  });

  it("rejects incomplete trace identity before provider execution", async () => {
    let calls = 0;
    await expect(
      agent(async () => {
        calls += 1;
        return createStopOutcome();
      }).run({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow("requires a trace context");
    expect(calls).toBe(0);
  });

  it("passes the configured abort signal through the LLM tool bridge", async () => {
    let capturedContext: Tool.ExecutionContext | undefined;
    let providerSteps = 0;
    mock.module("ai", () => ({
      jsonSchema: (schema: object) => ({ jsonSchema: schema }),
      stepCountIs: () => () => false,
      streamText: () => ({
        fullStream: (async function* () {
          providerSteps += 1;
          if (providerSteps === 1)
            yield { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: {} };
          yield { type: "finish" };
        })(),
      }),
    }));
    const controller = new AbortController();
    await ChatAgent.create({
      events: Bus,
      model,
      signal: controller.signal,
      auth: { type: "api", key: "test-key" },
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          inputSchema: { type: "object" },
          safe: true,
          placement: "host",
          requires: [],
        },
      ],
      toolExecutor: async (call, context) => {
        capturedContext = context;
        return { id: "result-1", toolCallId: call.id, output: "found" };
      },
      llm: { resolveModel: async () => mockProviderModel },
    }).run(runInput([{ role: "user", content: "hello" }]));

    expect(capturedContext?.signal).toBe(controller.signal);
  });

  it("rejects configured tools without an executor and emits no retry", async () => {
    let calls = 0;
    const retries: number[] = [];
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => retries.push(1));
    const configured = ChatAgent.create({
      events: Bus,
      model,
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          inputSchema: { type: "object" },
          safe: true,
          placement: "host",
          requires: [],
        },
      ],
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async () => {
          calls += 1;
          return createStopOutcome();
        },
      }),
    });
    try {
      await expect(configured.run(runInput([{ role: "user", content: "hello" }]))).rejects.toThrow(
        "toolExecutor",
      );
      expect(retries).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

describe("ChatAgent provider boundary failures", () => {
  it.each([
    {
      name: "a structured error without a message",
      outcome: { type: "error", error: { code: "provider_failed" } },
      message: "[object Object]",
    },
    { name: "an object without a type", outcome: {}, message: "Unknown outcome type: unknown" },
    {
      name: "an object with an unknown type",
      outcome: { type: "unexpected" },
      message: "Unknown outcome type: unexpected",
    },
    { name: "a primitive", outcome: 0, message: "Unknown outcome type: unknown" },
  ])("rejects $name", async ({ outcome, message }) => {
    const controller = new AbortController();
    const malformed = ChatAgent.create({
      events: Bus,
      model,
      signal: controller.signal,
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async () => {
          controller.abort();
          return outcome as never;
        },
      }),
    });

    await expect(malformed.run(runInput([{ role: "user", content: "malformed" }]))).rejects.toThrow(
      message,
    );
  });

  it("reports a missing default provider", async () => {
    await expect(
      ChatAgent.create({
        events: Bus,
        model: { provider: "missing-provider", id: "missing-model" },
        signal: AbortSignal.abort(),
      }).run(runInput([{ role: "user", content: "lookup" }])),
    ).rejects.toMatchObject({ data: { reason: "provider_not_found", provider: "missing-provider" } });
  });

  it("reports a non-Error proxy listing failure", async () => {
    const auth = spyOn(Auth, "get").mockResolvedValue({ type: "proxy", baseURL: "https://agent-missing-proxy.example" });
    const listing = spyOn(globalThis, "fetch").mockRejectedValue("proxy offline");
    try {
      await expect(
        ChatAgent.create({
          events: Bus,
          model: { provider: "anthropic", id: "missing-proxy-model" },
          signal: AbortSignal.abort(),
        }).run(runInput([{ role: "user", content: "lookup" }])),
      ).rejects.toMatchObject({ data: { reason: "proxy_listing_failed" }, cause: { cause: "proxy offline" } });
    } finally {
      listing.mockRestore();
      auth.mockRestore();
    }
  });

  it("reports a missing model in a known provider", async () => {
    await expect(
      ChatAgent.create({
        events: Bus,
        model: { provider: "anthropic", id: "missing-model" },
        signal: AbortSignal.abort(),
      }).run(runInput([{ role: "user", content: "lookup" }])),
    ).rejects.toMatchObject({ data: { reason: "model_not_found", model: "missing-model" } });
  });

  it("resolves a known model through the default provider path", async () => {
    const result = await ChatAgent.create({
      events: Bus,
      model: { provider: "anthropic", id: "claude-opus-4-5" },
      llm: { run: async () => createStopOutcome() },
    }).run(runInput([{ role: "user", content: "hello" }]));

    expect(result.finishReason).toBe("stop");
  });
});

describe("ChatAgent loop controls", () => {
  it("creates an instance with a run method", () => {
    expect(typeof agent(async () => createStopOutcome()).run).toBe("function");
  });

  it("passes the remaining tool-call budget as the model step cap", async () => {
    let maxSteps: number | undefined;
    await ChatAgent.create({
      events: Bus,
      model,
      budget: { maxToolCalls: 7 },
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async (input) => {
          maxSteps = input.maxSteps;
          return createStopOutcome();
        },
      }),
    }).run(runInput([{ role: "user", content: "hello" }]));
    expect(maxSteps).toBe(7);
  });

  it("honors an already-aborted signal before provider execution", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      ChatAgent.create({
        events: Bus,
        model,
        signal: controller.signal,
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => {
            calls += 1;
            return createStopOutcome();
          },
        }),
      }).run(runInput([{ role: "user", content: "hello" }])),
    ).rejects.toThrow("aborted");
    expect(calls).toBe(0);
  });
});
