import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Effect, Layer } from "effect";
import * as llmPackage from "../src/index";
import type { StreamEvent } from "../src/processor/stream-events";
import { usePrivateCatalog } from "./helpers/catalog";
import { runEffect } from "./helpers/native";

usePrivateCatalog();
beforeEach(() => {
  expect("LlmLive" in llmPackage).toBe(true);
  expect(Layer.isLayer(llmPackage.LlmLive)).toBe(true);
});
afterEach(() => mock.restore());

test("LlmLive resolves catalog models and preserves typed resolution failure", async () => {
  const resolved = await runEffect(Effect.gen(function* () {
    const llm = yield* llmPackage.Llm;
    const model = yield* llm.resolveModel({ provider: "anthropic", id: "fixture-claude" });
    const failure = yield* Effect.flip(llm.resolveModel({ provider: "absent", id: "missing" }));
    return { model, failure };
  }).pipe(Effect.provide(llmPackage.LlmLive)));

  expect(resolved.model).toMatchObject({ id: "fixture-claude", providerID: "anthropic" });
  expect(resolved.failure).toMatchObject({
    _tag: "ModelResolutionError", provider: "absent", model: "missing", reason: "provider_not_found",
  });
});

test.each([false, true])("LlmLive runs one real processor attempt (transport failure: %s)", async (fails) => {
  let attempts = 0;
  const outcome = await runEffect(Effect.gen(function* () {
    const llm = yield* llmPackage.Llm;
    const model = yield* llm.resolveModel({ provider: "anthropic", id: "fixture-claude" });
    return yield* llm.run({
      messages: [], tools: [], model,
      trace: { traceId: "layer-trace", sessionId: "layer-session", runId: "layer-run" },
      events: { publish: () => undefined },
    }, {
      onMessage: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined,
    }, {
      createStream: () => Effect.sync(() => {
        attempts += 1;
        return {
          fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
            yield { type: "step-finish", usage: { inputTokens: 17, outputTokens: 2 } };
            if (fails) throw Object.assign(new Error("overloaded"), { isRetryable: true, statusCode: 529 });
            yield { type: "finish", finishReason: "stop" };
          })(),
        };
      }),
    });
  }).pipe(Effect.provide(llmPackage.LlmLive)));

  expect(attempts).toBe(1);
  expect(outcome).toMatchObject(fails ? {
    type: "error", error: { visibleOutput: false, usage: { inputTokens: 17, outputTokens: 2 } },
  } : {
    type: "stop", evidence: { usage: { inputTokens: 17, outputTokens: 2 } },
  });
});
