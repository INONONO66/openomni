import { beforeEach, describe, expect, test } from "bun:test";
import { PolicyDecision, type Dispatch as DispatchProtocol } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";

function residentAskInput(): DispatchProtocol.Input {
  return { action: "resident.ask", target: { kind: "resident" }, payload: "hello" };
}

describe("DispatchRuntime canonical policy point", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("passes real top-level context without agent-loop fields", async () => {
    let observed: Readonly<Record<string, unknown>> = {};
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("resident.ask", () => ({ output: "ok" }));

    const result = await runtime.submit(
      { ...residentAskInput(), correlation: "message-1" },
      {
        sessionId: "session-1",
        runId: "run-1",
        actorKind: "resident",
        actorId: "resident:main",
        policies: [
          {
            kind: "point",
            name: "observe-dispatch-context",
            pointIds: ["dispatch.action.pre"],
            effectCapabilities: { "dispatch.action.pre": [] },
            priority: 0,
            fn: (ctx) => {
              observed = ctx;
              return PolicyDecision.allow({ policyId: "observe-dispatch-context" });
            },
          },
        ],
      },
    );

    expect(result.status).toBe("completed");
    expect(observed).toMatchObject({
      pointId: "dispatch.action.pre",
      timing: "dispatch.authorize",
      dispatchId: expect.any(String),
      action: "resident.ask",
      actor: { kind: "resident", actorId: "resident:main" },
      target: { kind: "resident" },
      correlation: "message-1",
      sessionId: "session-1",
      runId: "run-1",
      resourceDescriptor: { id: "dispatch:resident.ask", kind: "dispatch" },
      traceContext: { traceId: expect.any(String), sessionId: "session-1", runId: "run-1" },
      labels: [
        { value: "dispatch.resident.ask", source: "system" },
        { value: "actor.resident", source: "system" },
        { value: "target.resident", source: "system" },
      ],
    });
    for (const fabricated of [
      "steps",
      "usage",
      "turnCount",
      "isCompletion",
      "continuationCount",
      "elapsedMs",
      "toolInput",
    ]) {
      expect(Reflect.has(observed, fabricated)).toBe(false);
    }
  });

  test("denies missing session and run identity before policy and handler", async () => {
    let policyCalled = false;
    let handlerCalled = false;
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("resident.ask", () => {
      handlerCalled = true;
      return { output: "should not happen" };
    });

    const result = await runtime.submit(residentAskInput(), {
      actorKind: "resident",
      actorId: "resident:main",
      policies: [
        {
          kind: "point",
          name: "must-not-run-without-identity",
          pointIds: ["dispatch.action.pre"],
          effectCapabilities: { "dispatch.action.pre": [] },
          priority: 0,
          fn: () => {
            policyCalled = true;
            return PolicyDecision.allow({ policyId: "must-not-run-without-identity" });
          },
        },
      ],
    });

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("policy.context_missing");
    expect(policyCalled).toBe(false);
    expect(handlerCalled).toBe(false);
  });
});
