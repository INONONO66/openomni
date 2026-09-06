import { describe, expect, it, jest } from "bun:test";
import { RunEvents } from "../../../src/core/execution/events";
import { runAgent } from "../../../src/core/execution/run";
import { failureFacts } from "../../../src/core/retry";
import { Bus } from "../../../src/index";
import { createMockLlmConfig, mockProviderData, mockProviderModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

async function retryingFailure(operation: () => Promise<Error>): Promise<Error> {
  jest.useFakeTimers();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  let retries = 0;
  const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => {
    retries += 1;
    if (retries === 1) first.resolve();
    if (retries === 2) second.resolve();
  });
  try {
    const running = operation();
    await first.promise;
    jest.advanceTimersByTime(1_000);
    await second.promise;
    jest.advanceTimersByTime(2_000);
    return await running;
  } finally {
    unsubscribe();
    jest.useRealTimers();
  }
}

function llmFailure(message: string): Promise<Error> {
  return retryingFailure(async () => {
    try {
      await runAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => ({ type: "error", error: { message, name: "Error" } }),
        }),
      });
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error("expected failure");
  });
}

describe("terminal failure facts", () => {
  it("carries the classified reason, spent attempts, and ceiling", async () => {
    expect(failureFacts(await llmFailure("transient blip"))).toEqual({
      reason: "transient_error",
      attempt: 3,
      maxAttempts: 3,
      llm: true,
    });
  });

  it("keeps non-retryable validation failures at one attempt", async () => {
    let error: Error | undefined;
    try {
      await runAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => ({ type: "error", error: { message: "validation failed", name: "Error" } }),
        }),
      });
    } catch (caught) {
      if (caught instanceof Error) error = caught;
    }
    expect(failureFacts(error)).toEqual({ reason: "validation_error", attempt: 1, maxAttempts: 3, llm: true });
  });

  it("preserves error identity and keeps facts non-enumerable", async () => {
    const error = await llmFailure("transient blip");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("transient blip");
    expect(Object.keys(error)).not.toContain("failureFacts");
    expect(JSON.stringify({ ...error })).toBe("{}");
  });

  it("does not mark pre-provider or unrelated failures as LLM terminals", async () => {
    const error = await retryingFailure(async () => {
      try {
        await runAgent(runInput([{ role: "user", content: "hi" }]), {
          events: Bus,
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
          llm: { resolveModel: async () => { throw new Error("catalog invariant failed"); } },
        });
      } catch (caught) {
        if (caught instanceof Error) return caught;
        throw caught;
      }
      throw new Error("expected failure");
    });
    expect(failureFacts(error)).toBeUndefined();
    expect(failureFacts(new Error("unrelated"))).toBeUndefined();
    expect(failureFacts(undefined)).toBeUndefined();
    expect(failureFacts("a string throw")).toBeUndefined();
  });
});
