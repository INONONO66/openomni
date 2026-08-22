import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { RunDependencies } from "@openomni/llm";
import type { Model } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { allow } from "../helpers/policy-decision";
import { runInput } from "../helpers/run-input";

let providerCalls = 0;
let providerCallsByAgentAttempt: number[] = [];
let currentAgentAttempt = 0;
let providerFailure: (call: number) => Error | undefined = () => undefined;

const createProviderStream: NonNullable<RunDependencies["createStream"]> = async () => {
  providerCalls += 1;
  if (currentAgentAttempt > 0) {
    providerCallsByAgentAttempt[currentAgentAttempt - 1] =
      (providerCallsByAgentAttempt[currentAgentAttempt - 1] ?? 0) + 1;
  }
  const failure = providerFailure(providerCalls);
  return {
    fullStream: (async function* () {
      if (failure !== undefined) throw failure;
      yield { type: "finish" as const };
    })(),
  };
};

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;
let llmRun: typeof import("@openomni/llm").run;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
  // Bun module mocks are process-wide. A unique module identity prevents other
  // suites' `ai` mocks from replacing the llm.run instance under this test.
  const isolatedLlmModule = "../../../llm/src/run.ts?provider-retry-ownership";
  ({ run: llmRun } = await import(isolatedLlmModule));
});

afterEach(() => {
  Bus.reset();
});

function providerError(message: string, retryable: boolean): Error {
  return Object.assign(new Error(message), {
    name: "AI_APICallError",
    isRetryable: retryable,
    statusCode: retryable ? 529 : 400,
    responseHeaders: retryable ? { "Retry-After-Ms": "1" } : {},
  });
}

function resetProvider(failure: (call: number) => Error | undefined): void {
  providerCalls = 0;
  providerCallsByAgentAttempt = [];
  currentAgentAttempt = 0;
  providerFailure = failure;
}

const zeroBackoff = {
  kind: "point" as const,
  name: "test-zero-backoff",
  pointIds: ["run.error.error" as const],
  effectCapabilities: { "run.error.error": ["run.retry_after" as const] },
  priority: 100,
  fn: () =>
    allow("test.zero-backoff", undefined, [{ type: "run.retry_after" as const, delayMs: 0 }]),
};

function createAgent(signal?: AbortSignal) {
  return ChatAgent.create({
    events: Bus,
    model: { provider: "anthropic", id: "retry-owner-model" },
    auth: { type: "api", key: "test-key" },
    signal,
    llm: {
      run: (input, sink) => llmRun(input, sink, { createStream: createProviderStream }),
      resolveProviderModel: async (model: Model.Ref) => {
        currentAgentAttempt += 1;
        return {
          id: model.id,
          name: model.id,
          providerID: model.provider,
          api: { npm: "@ai-sdk/anthropic" },
        };
      },
    },
    middleware: [zeroBackoff],
  });
}

describe("Agent provider retry ownership", () => {
  test("issues exactly one provider call per Agent attempt", async () => {
    resetProvider((call) => (call === 1 ? providerError("provider overloaded", true) : undefined));

    const result = await createAgent().run(runInput([{ role: "user", content: "retry" }]));

    expect(result.finishReason).toBe("stop");
    expect(providerCallsByAgentAttempt).toEqual([1, 1]);
  });

  test("does not call the provider for an already-aborted Agent run", async () => {
    resetProvider(() => undefined);
    const controller = new AbortController();
    controller.abort();

    await expect(
      createAgent(controller.signal).run(runInput([{ role: "user", content: "abort" }])),
    ).rejects.toThrow("aborted");

    expect(providerCalls).toBe(0);
  });

  test("adds no provider call for a non-retryable Agent failure", async () => {
    resetProvider(() => providerError("validation failed", false));

    await expect(
      createAgent().run(runInput([{ role: "user", content: "invalid" }])),
    ).rejects.toThrow("validation failed");

    expect(providerCallsByAgentAttempt).toEqual([1]);
  });

  test("keeps standalone llm.run transport retry finite", async () => {
    resetProvider(() => providerError("provider overloaded", true));

    const outcome = await llmRun(
      {
        events: Bus,
        messages: [],
        tools: [],
        model: {
          id: "standalone-model",
          name: "standalone-model",
          providerID: "anthropic",
          api: { npm: "@ai-sdk/anthropic" },
        },
        auth: { type: "api", key: "test-key" },
        trace: {
          traceId: "trace-standalone-retry",
          sessionId: "session-standalone-retry",
          runId: "run-standalone-retry",
        },
      },
      {
        onMessage: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
      },
      { createStream: createProviderStream },
    );

    expect(outcome.type).toBe("error");
    expect(providerCalls).toBe(11);
  });
});
