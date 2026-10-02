import { Cause, Effect, Exit } from "effect";
import { expect, test } from "bun:test";
import { canonicalDigest, type PlainValue } from "@openomni/protocol";
import { AgentFailure } from "../src/kernel/failure";
import { createSessionRequests } from "../src/session/request";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { allowConfigure, isolatedRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";

const setup = Effect.gen(function* () {
  yield* isolatedLedger().kernel.materialize({
    id: "source",
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
    actionId: "configure",
    at: 1,
  });
  const actions = isolatedLedger().session.actions;
  const invocation = (id: string, intent: PlainValue) => {
    actions.append(
      {
        id,
        sessionId: "source",
        parentId: "configure",
        kind: "message",
        intent: { encodingVersion: 1, value: intent },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        irreversible: true,
        ts: 1,
      },
      isolatedLedger().kernel.row("source").revision,
    );
  };
  invocation("first", { phase: "intent", value: { messageId: "first" }, effectHash: canonicalDigest({}) });
  invocation("stale-turn", {
    phase: "intent",
    turnId: "missing-turn",
    value: { messageId: "stale-turn" },
    effectHash: canonicalDigest({}),
  });
});

const opening = (requestId: string) => ({
  requestId,
  sessionId: "source",
  expectedResponders: ["peer"],
  correlation: {},
  allowedActions: ["report_result" as const],
  resolution: "first" as const,
  threshold: 1,
  deadline: 200,
  at: 100,
});

function gatewayPort() {
  return Effect.gen(function* () {
    const fixture: SessionFixture = {
      clock: () => 100,
      observations: { publish: () => undefined },
      authorizeConfigure: allowConfigure,
      ...isolatedRuntime(),
    };
    return yield* withSessionServices(createSessionRequests(fixture), fixture);
  });
}

test("a timeout for an unknown request is a defect, not a typed session failure", () => isolated(Effect.gen(function* () {
  yield* setup;
  const port = yield* gatewayPort();
  const exit = yield* Effect.exit(port.timeout("absent", 150));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.hasFails(exit.cause)).toBe(false);
  }
})));

test("opening over a missing original invocation is a defect, not a typed session failure", () => isolated(Effect.gen(function* () {
  yield* setup;
  const port = yield* gatewayPort();
  const exit = yield* Effect.exit(port.open(opening("never-recorded")));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.hasFails(exit.cause)).toBe(false);
  }
})));

test("an unavailable original generation fails with a typed AgentFailure", () => isolated(Effect.gen(function* () {
  yield* setup;
  const port = yield* gatewayPort();
  const error = yield* Effect.flip(port.open(opening("stale-turn")));
  expect(error).toBeInstanceOf(AgentFailure);
  expect(error).toMatchObject({
    _tag: "AgentFailure",
    operation: "request.open",
    cause: "original_generation_unavailable",
  });
})));

test("a refused request open fails with a typed AgentFailure", () => isolated(Effect.gen(function* () {
  yield* setup;
  const port = yield* gatewayPort();
  yield* port.open(opening("first"));
  // Same inputId, different content: the kernel rejects the conflicting reopen.
  const exit = yield* Effect.exit(port.open({ ...opening("first"), deadline: 300 }));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasFails(exit.cause)).toBe(true);
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(AgentFailure);
    expect(error).toMatchObject({ _tag: "AgentFailure", operation: "request.open", cause: "refused:first" });
  }
})));

test("a refused delivery receipt fails with a typed AgentFailure", () => isolated(Effect.gen(function* () {
  yield* setup;
  const port = yield* gatewayPort();
  yield* port.open(opening("first"));
  const exit = yield* Effect.exit(port.receipt({
    inputId: "bad",
    requestId: "first",
    sessionId: "source",
    sourceActionId: "second",
    value: "accepted",
    at: 100,
  }));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasFails(exit.cause)).toBe(true);
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(AgentFailure);
    expect(error).toMatchObject({ _tag: "AgentFailure", operation: "request.receipt", cause: "refused:first" });
  }
})));
