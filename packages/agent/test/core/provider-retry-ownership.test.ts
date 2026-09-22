import { Effect } from "effect";
import { isolated } from "../helpers/isolated";
import { createTestAgent, failure as effectFailure } from "../helpers/effect-g2";
import { afterEach, describe, expect, it } from "bun:test";
import { LlmRunFailure, run as llmRun, type run } from "@openomni/llm";
import type { Model } from "@openomni/protocol";
import { RunEvents } from "../../src/core/execution/events";
import { Bus } from "../../src/index";
import { failureFacts } from "../../src/core/retry";
import { runInput } from "../helpers/run-input";

let providerCalls = 0;
let callsByAttempt: number[] = [];
let attempt = 0;
let providerFailure: (call: number) => Error | undefined = () => undefined;

const createProviderStream: NonNullable<Parameters<typeof run>[2]>["createStream"] = () =>
  Effect.sync(() => {
    providerCalls += 1;
    if (attempt > 0) callsByAttempt[attempt - 1] = (callsByAttempt[attempt - 1] ?? 0) + 1;
    const failure = providerFailure(providerCalls);
    return {
      fullStream: (async function* () {
        if (failure !== undefined) throw failure;
        yield { type: "text-start" };
        yield { type: "text-delta", text: "completed" };
        yield { type: "text-end" };
        yield { type: "finish" as const };
      })(),
    };
  });

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
  return createTestAgent({
    events: Bus,
    model: { provider: "anthropic", id: "retry-owner-model" },
    auth: { type: "api", key: "test-key" },
    signal,
    llm: {
      run: (input: import("@openomni/llm").RunInput, sink: import("@openomni/llm").Sink) =>
        llmRun(input, sink, { createStream: createProviderStream }),
      resolveModel: (model: Model.Ref) =>
        Effect.promise(async () => {
          attempt += 1;
          return {
            id: model.id,
            name: model.id,
            providerID: model.provider,
            api: { npm: "@ai-sdk/anthropic" },
          };
        }),
    },
  });
}

describe("provider retry ownership", () => {
  it("issues exactly one provider call per agent attempt", async () => {
    let retries = 0;
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => {
      retries += 1;
    });
    resetProvider((call: number) =>
      call === 1 ? providerError("provider overloaded", true) : undefined,
    );
    try {
      const result = await isolated(
        createAgent().run(runInput([{ role: "user", content: "retry" }])),
      );
      expect(result.finishReason).toBe("stop");
      expect(retries).toBe(1);
      expect(callsByAttempt).toEqual([1, 1]);
    } finally {
      unsubscribe();
    }
  });

  it("does not call the provider for an already-aborted run", async () => {
    resetProvider(() => undefined);
    const controller = new AbortController();
    controller.abort();
    expect(
      await isolated(
        effectFailure(
          createAgent(controller.signal).run(runInput([{ role: "user", content: "abort" }])),
        ),
      ),
    ).toMatchObject({ _tag: "Interrupted" });
    expect(providerCalls).toBe(0);
  });

  it("does not add an agent attempt for a non-retryable provider failure", async () => {
    resetProvider(() => providerError("validation failed", false));
    expect(
      await isolated(
        effectFailure(createAgent().run(runInput([{ role: "user", content: "invalid" }]))),
      ),
    ).toMatchObject({ _tag: "LlmRunFailure", isRetryable: false, statusCode: 400 });
    expect(callsByAttempt).toEqual([1]);
  });

  it("standalone llm runs exactly one provider attempt", async () => {
    resetProvider(() => providerError("provider overloaded", true));
    const outcome = await isolated(
      llmRun(
        {
          events: Bus,
          messages: [],
          tools: [],
          model: {
            id: "standalone",
            name: "standalone",
            providerID: "anthropic",
            api: { npm: "@ai-sdk/anthropic" },
          },
          auth: { type: "api", key: "test-key" },
          trace: { traceId: "trace", sessionId: "session", runId: "run" },
        },
        { onMessage: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined },
        { createStream: createProviderStream },
      ),
    );
    expect(outcome.type).toBe("error");
    expect(providerCalls).toBe(1);
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
  overrides: Partial<ConstructorParameters<typeof LlmRunFailure>[0]>,
  cause?: Error,
) {
  return new LlmRunFailure({
    message: "opaque provider failure",
    usage: zeroUsage,
    aborted: false,
    contextOverflow: false,
    visibleOutput: false,
    cause: cause === undefined ? undefined : String(cause),
    ...overrides,
  });
}

async function classified(providerFailure: LlmRunFailure) {
  let calls = 0;
  const thrown = await isolated(
    effectFailure(
      createTestAgent({
        events: Bus,
        model: { provider: "anthropic", id: "model" },
        llm: {
          resolveModel: () =>
            Effect.promise(async () => ({ id: "model", name: "model", providerID: "anthropic" })),
          run: () =>
            Effect.promise(async () => {
              calls += 1;
              return { type: "error", error: providerFailure };
            }),
        },
      }).run(runInput([{ role: "user", content: "hello" }])),
    ),
  );
  return { calls, thrown };
}

describe("typed provider failure preservation", () => {
  it("preserves abort identity without retry", async () => {
    const providerFailure = failure({ aborted: true, retryAfterMs: 1_234 });
    const result = await classified(providerFailure);
    expect(result).toEqual({ calls: 1, thrown: providerFailure });
    expect(failureFacts(result.thrown)).toMatchObject({ reason: "aborted", attempt: 1 });
    expect(providerFailure.retryAfterMs).toBe(1_234);
  });

  it("preserves context-overflow cause and usage without blind retry", async () => {
    const cause = new Error("socket closed");
    const usage = { ...zeroUsage, inputTokens: 17, outputTokens: 5 };
    const providerFailure = failure({ contextOverflow: true, usage }, cause);
    const result = await classified(providerFailure);
    expect(result.calls).toBe(1);
    expect(result.thrown).toBe(providerFailure);
    expect(providerFailure.cause).toBe(String(cause));
    expect(providerFailure.usage).toEqual(usage);
  });
});
