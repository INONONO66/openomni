import { createTestAgent } from "../helpers/test-agent";
import { describe, expect, it, mock } from "bun:test";
import type { RunInput, Sink } from "@openomni/llm";
import { Bus } from "../../src/index";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

/** `calls` distinguishes "the llm was never called" from "called without transport". */
let calls = 0;
let seenTransport: RunInput["transport"];

const mockLlm = createMockLlmConfig({
  getModels: mock(async () => mockProviderData),
  fromModelsDevModel: mock(() => mockProviderModel),
  run: async (input, _sink: Sink) => {
    calls += 1;
    seenTransport = (input as RunInput).transport;
    return createStopOutcome();
  },
});

const baseConfig = {
  events: Bus,
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  llm: mockLlm,
};

describe("operator transport config threading", () => {
  it("hands the configured baseUrl and headers to the llm call", async () => {
    calls = 0;
    seenTransport = undefined as RunInput["transport"];
    const agent = createTestAgent({
      ...baseConfig,
      transport: {
        baseUrl: "https://gateway.internal/v1",
        headers: { "x-tenant": "acme" },
      },
    });

    await agent.run(runInput([{ role: "user", content: "hi" }]));

    expect(calls).toBe(1);
    expect(seenTransport).toEqual({
      baseUrl: "https://gateway.internal/v1",
      headers: { "x-tenant": "acme" },
    });
  });

  it("leaves transport absent when the host configured none", async () => {
    calls = 0;
    seenTransport = { baseUrl: "never-read" };
    const agent = createTestAgent(baseConfig);

    await agent.run(runInput([{ role: "user", content: "hi" }]));

    expect(calls).toBe(1);
    expect(seenTransport).toBeUndefined();
  });
});
