import { expect, test } from "bun:test";
import { Effect } from "effect";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { AgentStopError, ContextAdmissionError } from "../src/errors";
import { failureEvidence } from "../src/executor-outcome";
import { createRetryAlarmPort } from "../src/executor-retry-alarm";
import { AgentGenerationLive } from "../src/layers";
import { Clock, Entropy, ObservationSink, SessionLayer, ToolCatalog } from "../src/services";
import { allowAllPolicy } from "./helpers/compiled-policy";
import { isolated } from "./helpers/isolated";

test("context admission failure remains typed and has closed durable evidence", () => isolated(Effect.gen(function* () {
  const error = new ContextAdmissionError();
  expect((yield* Effect.flip(error))._tag).toBe("ContextAdmissionError");
  expect(failureEvidence(error)).toEqual({ tag: "ContextAdmissionError" });
  const stopped = new AgentStopError({ reason: "budget" });
  expect((yield* Effect.flip(stopped))._tag).toBe("AgentStopError");
  expect(failureEvidence(stopped)).toEqual({ tag: "AgentStopError", code: "agent_stop", reason: "budget" });
})));

test("the generation layer supplies the captured policy, tools, observations, clock and entropy", () => isolated(Effect.gen(function* () {
  yield* SessionHandleStore.materialize({
    id: "layer-session", role: "resident", parentId: null, tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: 1, actionId: "configure", at: 1,
  });
  const snapshot = SessionHandleStore.latestGenerationFor("layer-session");
  const observations = { publish: (): void => undefined };
  const options = {
    now: (): number => 123, next: (): string => "fixed-id", observations,
    snapshot, policy: allowAllPolicy, definitions: [],
  };
  const services = yield* Effect.gen(function* () {
    return {
      time: (yield* Clock).now(), id: (yield* Entropy).next(),
      observations: yield* ObservationSink, session: yield* SessionLayer, tools: yield* ToolCatalog,
    };
  }).pipe(Effect.provide(AgentGenerationLive(options)));
  expect(services.time).toBe(123);
  expect(services.id).toBe("fixed-id");
  expect(services.observations).toBe(observations);
  expect(services.session.snapshot).toBe(snapshot);
  expect(services.session.policy).toBe(allowAllPolicy);
  expect(services.tools.definitions).toBe(options.definitions);
})));

test("retry settlement is idempotent but never consumes another session's alarm", () => isolated(Effect.gen(function* () {
  yield* SessionHandleStore.materialize({
    id: "retry-owner", role: "resident", parentId: null, tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: 1, actionId: "configure", at: 1,
  });
  const owner = createRetryAlarmPort("retry-owner", (): number => 2);
  yield* owner.settle("missing");
  yield* owner.arm({ id: "retry", attempt: 1, reason: "transient_error", fireAt: 10 });
  expect(yield* Effect.flip(createRetryAlarmPort("other", (): number => 2).settle("retry")))
    .toMatchObject({ _tag: "CommitFailed", error: { _tag: "AlarmRefused", reason: "session", operation: "cancel" } });
  expect(Storage.get().alarms?.get("retry")?.status).toBe("armed");
  yield* owner.settle("retry");
  yield* owner.settle("retry");
  expect(Storage.get().alarms?.get("retry")?.status).toBe("cancelled");
})));
