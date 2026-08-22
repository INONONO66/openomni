import { describe, expect, it } from "bun:test";
import { Run } from "@openomni/llm";
import { Bus } from "@openomni/telemetry";
import { runAgent } from "../../../src/core/execution/run";
import { abortRun } from "../../helpers/policy-decision";
import { createMockLlmConfig, mockProviderData, mockProviderModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

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
