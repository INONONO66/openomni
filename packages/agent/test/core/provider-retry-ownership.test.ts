import { afterEach, beforeAll, describe, expect, it, test } from "bun:test";
import { Run, type RunDependencies } from "@openomni/llm";
import type { Model } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { abortRun, allow } from "../helpers/policy-decision";
import { createMockLlmConfig, mockProviderData, mockProviderModel } from "../helpers/mock-llm";
import { runAgent } from "../../src/core/execution/run";
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

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function failure(
  overrides: Partial<ConstructorParameters<typeof Run.FailureError>[0]>,
  cause?: unknown,
): InstanceType<typeof Run.FailureError> {
  return new Run.FailureError(
    {
      message: "opaque provider failure",
      usage: zeroUsage,
      aborted: false,
      contextOverflow: false,
      ...overrides,
    },
    cause === undefined ? undefined : { cause },
  );
}

async function consume(providerFailure: InstanceType<typeof Run.FailureError>) {
  let consumed: Record<string, unknown> | undefined;
  await runAgent(runInput([{ role: "user", content: "hello" }]), {
    events: Bus,
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    middleware: [
      {
        kind: "point",
        name: "capture-provider-failure",
        pointIds: ["run.error.error"],
        effectCapabilities: { "run.error.error": ["run.abort"] },
        priority: 100,
        fn: (ctx) => {
          consumed = ctx.toolInput?.error as Record<string, unknown> | undefined;
          return abortRun("test.capture", "captured");
        },
      },
    ],
    llm: createMockLlmConfig({
      getModels: async () => mockProviderData,
      fromModelsDevModel: () => mockProviderModel,
      run: async () => ({ type: "error", error: providerFailure }),
    }),
  });
  return consumed;
}

async function classify(providerFailure: InstanceType<typeof Run.FailureError>) {
  let calls = 0;
  let thrown: unknown;
  try {
    await runAgent(runInput([{ role: "user", content: "hello" }]), {
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async () => {
          calls += 1;
          return { type: "error", error: providerFailure };
        },
      }),
    });
  } catch (error) {
    thrown = error;
  }
  return { calls, thrown };
}

describe("typed provider failure preservation", () => {
  it("preserves retry-after at the Agent error consumer", async () => {
    expect(await consume(failure({ retryAfterMs: 1_234 }))).toMatchObject({
      retryAfterMs: 1_234,
    });
  });

  it("preserves the cause chain through Agent classification", async () => {
    const cause = new Error("socket closed");
    const result = await classify(failure({ contextOverflow: true }, cause));
    expect(result.calls).toBe(1);
    expect((result.thrown as Error).cause).toBe(cause);
  });

  it("preserves provider usage at the Agent error consumer", async () => {
    const usage = {
      inputTokens: 17,
      outputTokens: 5,
      reasoningTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    };
    expect(await consume(failure({ usage }))).toMatchObject({ usage });
  });

  it("uses the typed abort flag without message classification or retry", async () => {
    const providerFailure = failure({ aborted: true });
    const result = await classify(providerFailure);
    expect(result.calls).toBe(1);
    expect(result.thrown).toBe(providerFailure);
  });

  it("uses the typed context-overflow fact without message classification or blind retry", async () => {
    const providerFailure = failure({ contextOverflow: true });
    const result = await classify(providerFailure);
    expect(result.calls).toBe(1);
    expect(result.thrown).toBe(providerFailure);
  });
});
