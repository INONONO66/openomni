import { afterEach, describe, expect, it, jest } from "bun:test";
import { Run, run as llmRun, type run } from "@openomni/llm";
import type { Model } from "@openomni/protocol";
import { RunEvents } from "../../src/core/execution/events";
import { ChatAgent } from "../../src/core/chat-agent";
import { Bus } from "../../src/index";
import { failureFacts } from "../../src/core/retry";
import { runInput } from "../helpers/run-input";

let providerCalls = 0;
let callsByAttempt: number[] = [];
let attempt = 0;
let providerFailure: (call: number) => Error | undefined = () => undefined;

const createProviderStream: NonNullable<Parameters<typeof run>[2]>["createStream"] = async () => {
  providerCalls += 1;
  if (attempt > 0) callsByAttempt[attempt - 1] = (callsByAttempt[attempt - 1] ?? 0) + 1;
  const failure = providerFailure(providerCalls);
  return { fullStream: (async function* () { if (failure !== undefined) throw failure; yield { type: "finish" as const }; })() };
};

afterEach(() => Bus.reset());

function providerError(message: string, retryable: boolean): Error {
  return Object.assign(new Error(message), {
    name: "AI_APICallError",
    isRetryable: retryable,
    statusCode: retryable ? 529 : 400,
    responseHeaders: retryable ? { "Retry-After-Ms": "0" } : {},
  });
}

function resetProvider(failure: (call: number) => Error | undefined): void {
  providerCalls = 0;
  callsByAttempt = [];
  attempt = 0;
  providerFailure = failure;
}

function createAgent(signal?: AbortSignal) {
  return ChatAgent.create({
    events: Bus,
    model: { provider: "anthropic", id: "retry-owner-model" },
    auth: { type: "api", key: "test-key" },
    signal,
    llm: {
      run: (input, sink) => llmRun(input, sink, { createStream: createProviderStream }),
      resolveProviderModel: async (model: Model.Ref) => {
        attempt += 1;
        return { id: model.id, name: model.id, providerID: model.provider, api: { npm: "@ai-sdk/anthropic" } };
      },
    },
  });
}

describe("provider retry ownership", () => {
  it("issues exactly one provider call per agent attempt", async () => {
    jest.useFakeTimers();
    const retry = Promise.withResolvers<void>();
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
    resetProvider((call) => call === 1 ? providerError("provider overloaded", true) : undefined);
    try {
      const running = createAgent().run(runInput([{ role: "user", content: "retry" }]));
      await retry.promise;
      jest.advanceTimersByTime(1_000);
      expect((await running).finishReason).toBe("stop");
      expect(callsByAttempt).toEqual([1, 1]);
    } finally {
      unsubscribe();
      jest.useRealTimers();
    }
  });

  it("does not call the provider for an already-aborted run", async () => {
    resetProvider(() => undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(createAgent(controller.signal).run(runInput([{ role: "user", content: "abort" }]))).rejects.toThrow("aborted");
    expect(providerCalls).toBe(0);
  });

  it("does not add an agent attempt for a non-retryable provider failure", async () => {
    resetProvider(() => providerError("validation failed", false));
    await expect(createAgent().run(runInput([{ role: "user", content: "invalid" }]))).rejects.toThrow("validation failed");
    expect(callsByAttempt).toEqual([1]);
  });

  it("keeps standalone llm transport retries finite", async () => {
    resetProvider(() => providerError("provider overloaded", true));
    const outcome = await llmRun({
      events: Bus,
      messages: [],
      tools: [],
      model: { id: "standalone", name: "standalone", providerID: "anthropic", api: { npm: "@ai-sdk/anthropic" } },
      auth: { type: "api", key: "test-key" },
      trace: { traceId: "trace", sessionId: "session", runId: "run" },
    }, { onMessage: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined }, { createStream: createProviderStream });
    expect(outcome.type).toBe("error");
    expect(providerCalls).toBe(11);
  });
});

const zeroUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
function failure(overrides: Partial<ConstructorParameters<typeof Run.FailureError>[0]>, cause?: Error) {
  return new Run.FailureError({ message: "opaque provider failure", usage: zeroUsage, aborted: false, contextOverflow: false, ...overrides }, cause === undefined ? undefined : { cause });
}

async function classified(providerFailure: InstanceType<typeof Run.FailureError>) {
  let calls = 0;
  let thrown: Error | undefined;
  try {
    await ChatAgent.create({
      events: Bus,
      model: { provider: "anthropic", id: "model" },
      llm: { resolveProviderModel: async () => ({ id: "model", name: "model", providerID: "anthropic" }), run: async () => { calls += 1; return { type: "error", error: providerFailure }; } },
    }).run(runInput([{ role: "user", content: "hello" }]));
  } catch (error) {
    if (error instanceof Error) thrown = error;
  }
  return { calls, thrown };
}

describe("typed provider failure preservation", () => {
  it("preserves abort identity without retry", async () => {
    const providerFailure = failure({ aborted: true, retryAfterMs: 1_234 });
    const result = await classified(providerFailure);
    expect(result).toEqual({ calls: 1, thrown: providerFailure });
    expect(failureFacts(result.thrown)).toMatchObject({ reason: "aborted", attempt: 1 });
    expect(providerFailure.data.retryAfterMs).toBe(1_234);
  });

  it("preserves context-overflow cause and usage without blind retry", async () => {
    const cause = new Error("socket closed");
    const usage = { ...zeroUsage, inputTokens: 17, outputTokens: 5 };
    const providerFailure = failure({ contextOverflow: true, usage }, cause);
    const result = await classified(providerFailure);
    expect(result.calls).toBe(1);
    expect(result.thrown).toBe(providerFailure);
    expect(providerFailure.cause).toBe(cause);
    expect(providerFailure.data.usage).toEqual(usage);
  });
});
