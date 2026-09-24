import { expect, test } from "bun:test";
import { APIError, Retry, run as runLlm, type RunInput } from "@openomni/llm";
import { PlainObjectSchema, type LedgerAction, type Model } from "@openomni/protocol";
import { Effect } from "effect";
import type { StreamEvent } from "../../llm/src/processor/stream-events";
import { runAgent } from "../src/core/execution/run";
import { ForeignFailure as LedgerFailure } from "@openomni/ledger";
import { isolated } from "./helpers/isolated";
import { requestLedger } from "./helpers/effect-g1";
import { testExecutor } from "./helpers/executor";
import { compiledPolicy } from "./helpers/compiled-policy";
import { chatServices, type ChatFixture } from "./helpers/chat-services";
import { runInput } from "./helpers/run-input";

const primary = { provider: "route-a", id: "model-a" };
const fallback = { provider: "route-b", id: "model-b" };
const usage = { inputTokens: 17, outputTokens: 2 };
type Prefix = "none" | "reasoning" | "text" | "tool";

function providerFailure(floor: number) {
  return new APIError({
    message: "overloaded", isRetryable: true, statusCode: 529,
    responseHeaders: { "retry-after-ms": String(floor) },
  });
}

function stream(prefix: Prefix, failed: boolean, floor: number): AsyncIterable<StreamEvent> {
  return (async function* () {
    if (prefix === "reasoning") yield { type: "reasoning-delta", id: "r", text: "private" };
    if (prefix === "text" || !failed) yield { type: "text-delta", text: "answer" };
    if (prefix === "tool") yield { type: "tool-call", toolCallId: "call", toolName: "write", input: {} };
    yield { type: "step-finish", finishReason: "stop", usage };
    if (failed) throw providerFailure(floor);
    yield { type: "finish", finishReason: "stop" };
  })();
}

function scenario(prefix: Prefix, floor = 0, veto = false) {
  return Effect.gen(function* () {
    const committed: LedgerAction.Append[] = [];
    const providers: string[] = [];
    const resolved: Model.Ref[] = [];
    const arms: number[] = [];
    const recording = yield* requestLedger({ clock: () => 1 });
    const executor = testExecutor({
      ...recording, policy: compiledPolicy(), observations: { publish: () => undefined },
      ledger: { ...recording.ledger, commit: (action) => {
        if (veto && action.kind === "message") return Effect.fail(new LedgerFailure({
          operation: "canonical.write", cause: "refused",
        }));
        return recording.ledger.commit(action).pipe(Effect.tap(() => Effect.sync(() => { committed.push(action); })));
      } },
      retryAlarm: {
        arm: (input) => Effect.sync(() => { arms.push(input.fireAt); }),
        wait: () => Effect.void,
        settle: () => Effect.void,
      },
    });
    const fixture: ChatFixture = {
      model: primary, modelFallbacks: [fallback], executor, execution: executor,
      events: { publish: () => undefined },
      llm: {
        resolveModel: (model) => Effect.sync(() => {
          resolved.push(model);
          return { id: model.id, name: model.id, providerID: model.provider };
        }),
        run: (input: RunInput, sink) => runLlm(input, sink, {
          createStream: () => Effect.sync(() => {
            providers.push(input.model.providerID);
            return { fullStream: stream(prefix, !veto && providers.length === 1, floor) };
          }),
        }),
      },
    };
    const { events: _events, llm: _llm, ...config } = fixture;
    const result = yield* Effect.either(runAgent(runInput([{ role: "user", content: "go" }]), config)
      .pipe(Effect.provide(chatServices(fixture))));
    return { result, committed, providers, resolved, arms };
  });
}

function attempts(actions: readonly LedgerAction.Append[]) {
  return actions.filter((action) => action.kind === "attempt" &&
    PlainObjectSchema.parse(action.intent.value).phase === "intent");
}

for (const prefix of ["text", "tool"] as const) {
  test(`a failed ${prefix} prefix forbids fallback and keeps billed evidence`, () => isolated(Effect.gen(function* () {
    const value = yield* scenario(prefix);
    expect(value.result._tag).toBe("Left");
    expect(value.providers).toEqual([primary.provider]);
    expect(value.arms).toEqual([]);
    expect(attempts(value.committed)).toHaveLength(1);
    const result = value.committed.find((action) => action.kind === "attempt" &&
      PlainObjectSchema.parse(action.effect.value).phase === "result");
    expect(result?.effect.value).toMatchObject({ evidence: { failures: [{
      tag: "LlmRunFailure", visibleOutput: true, usage,
    }] } });
    expect(result?.parentId).toBe(attempts(value.committed)[0]?.id);
    expect(attempts(value.committed)[0]?.intent.value).toMatchObject({ value: { provider: primary.provider, model: primary.id } });
    expect(value.committed.filter((action) => action.kind === "message" || action.kind === "tool")).toEqual([]);
  })));
}

test("reasoning-only failure re-admits the fallback and attributes the failure to the original route", () => isolated(Effect.gen(function* () {
  const value = yield* scenario("reasoning");
  expect(value.result._tag).toBe("Right");
  expect(value.providers).toEqual([primary.provider, fallback.provider]);
  expect(value.resolved).toEqual([primary, fallback]);
  expect(value.arms).toEqual([1]);
  const children = attempts(value.committed);
  expect(children).toHaveLength(2);
  expect(children[1]?.intent.value).toMatchObject({
    attempt: 2, maxAttempts: 3, retryReason: "transient_error",
    routeChange: { kind: "route.changed", fromActionId: children[0]?.id,
      from: { provider: primary.provider, model: primary.id },
      to: { provider: fallback.provider, model: fallback.id } },
  });
  expect(value.committed.find((action) => action.parentId === children[0]?.id)?.effect.value)
    .toMatchObject({ evidence: { failures: [{ usage, visibleOutput: false }] } });
  expect(children[0]?.intent.value).toMatchObject({ value: { provider: primary.provider, model: primary.id } });
  expect(value.committed.filter((action) => action.kind === "message")).not.toHaveLength(0);
})));

test("a canonical assistant write refusal vetoes fallback after a successful provider attempt", () => isolated(Effect.gen(function* () {
  const value = yield* scenario("none", 0, true);
  expect(value.result).toMatchObject({ _tag: "Left", left: { _tag: "CommitFailed" } });
  expect(value.providers).toEqual([primary.provider]);
  expect(value.resolved).toEqual([primary]);
  expect(value.arms).toEqual([]);
  expect(value.committed.filter((action) => action.kind === "message" || action.kind === "tool")).toEqual([]);
})));

test("a provider floor beyond the retry header budget stops without scheduling an early retry", () => isolated(Effect.gen(function* () {
  const value = yield* scenario("none", Retry.RETRY_HEADER_DELAY_CAP + 1);
  expect(value.result._tag).toBe("Left");
  expect(value.providers).toEqual([primary.provider]);
  expect(value.arms).toEqual([]);
  expect(attempts(value.committed)).toHaveLength(1);
})));
