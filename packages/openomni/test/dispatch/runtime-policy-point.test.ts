import { beforeEach, describe, expect, test } from "bun:test";
import { PolicyDecision, type Command } from "@openomni/protocol";
import { Storage } from "@openomni/ledger";
import { DispatchRuntime } from "../../src/dispatch/runtime";

/** A dispatch inherits the trace of whatever ordered it; the runtime refuses to mint one. */
const TEST_DISPATCH_TRACE_ID = "trace-dispatch-test";

function residentAskInput(): Command.Input {
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
        traceId: TEST_DISPATCH_TRACE_ID,
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

  test("runs policy and handler without optional session and run identity", async () => {
    let policyCalled = false;
    let handlerCalled = false;
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("resident.ask", () => {
      handlerCalled = true;
      return { output: "ok" };
    });

    const result = await runtime.submit(residentAskInput(), {
      traceId: TEST_DISPATCH_TRACE_ID,
      actorKind: "resident",
      actorId: "resident:main",
      policies: [
        {
          kind: "point",
          name: "allow-dispatch-without-run-identity",
          pointIds: ["dispatch.action.pre"],
          effectCapabilities: { "dispatch.action.pre": [] },
          priority: 0,
          fn: () => {
            policyCalled = true;
            return PolicyDecision.allow({ policyId: "allow-dispatch-without-run-identity" });
          },
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("ok");
    expect(policyCalled).toBe(true);
    expect(handlerCalled).toBe(true);
  });
});
