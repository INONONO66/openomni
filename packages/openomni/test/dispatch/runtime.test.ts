import { beforeEach, describe, expect, test } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import {
  allowDispatchPolicy,
  flushBus,
  input,
  resetDispatchTestState,
} from "./runtime-test-fixtures";

describe("DispatchRuntime", () => {
  beforeEach(resetDispatchTestState);

  test("authorizes before routing and completes a handler", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    let called = false;
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("resident.ask", async () => {
      called = true;
      return { output: "ok" };
    });

    const result = await runtime.submit(input(), {
      sessionId: "session-1",
      runId: "run-1",
      agentName: "resident",
      policies: [allowDispatchPolicy()],
    });

    await flushBus();
    expect(result.status).toBe("completed");
    expect(result.output).toBe("ok");
    expect(called).toBe(true);
    expect(events.filter((event) => event.startsWith("dispatch."))).toEqual([
      "dispatch.submitted",
      "dispatch.authorized",
      "dispatch.routed",
      "dispatch.completed",
    ]);
  });

  test("deny returns before handler invocation", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    let called = false;
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("worker.spawn", async () => {
      called = true;
      return { output: "should not happen" };
    });

    const result = await runtime.submit(input("worker.spawn"), {
      sessionId: "session-1",
      runId: "run-1",
      agentName: "worker",
      policies: [
        {
          kind: "point",
          name: "deny-dispatch",
          pointIds: ["dispatch.action.pre"],
          effectCapabilities: { "dispatch.action.pre": ["run.abort"] },
          priority: 0,
          fn: () =>
            PolicyDecision.deny({
              policyId: "deny-dispatch",
              reasonCodes: ["no"],
              effects: [{ type: "run.abort", reason: "no" }],
            }),
        },
      ],
    });

    await flushBus();
    expect(result.status).toBe("denied");
    expect(called).toBe(false);
    expect(events).toContain("dispatch.denied");
    expect(events).not.toContain("dispatch.routed");
  });

  test("rejects duplicate handler registrations", () => {
    const runtime = new DispatchRuntime();
    runtime.register("resident.ask", () => ({ output: "first" }));

    expect(() => runtime.register("resident.ask", () => ({ output: "second" }))).toThrow(
      "dispatch action already registered: resident.ask",
    );
  });

  test("audit events stay envelope-only without payload or result summaries", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    Bus.observe((event, data) => {
      if (event.name.startsWith("dispatch.")) {
        payloads.push(data as Record<string, unknown>);
      }
    });
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("resident.ask", () => ({ output: "private output" }));

    await runtime.submit(
      {
        action: "resident.ask",
        target: { kind: "resident" },
        payload: "private input",
      },
      {
        sessionId: "session-audit",
        runId: "run-audit",
        actorKind: "resident",
        actorId: "resident:main",
        policies: [allowDispatchPolicy()],
      },
    );

    expect(payloads.some((payload) => "payloadSummary" in payload)).toBe(false);
    expect(payloads.some((payload) => "resultSummary" in payload)).toBe(false);
  });

  test("fails unknown action without routing", async () => {
    const result = await new DispatchRuntime({ includeDefaultPolicies: false }).submit(
      { action: "custom.missing", target: { kind: "system" } },
      {
        sessionId: "session-missing-action",
        runId: "run-missing-action",
        actorKind: "system",
        actorId: "system:test",
        policies: [allowDispatchPolicy()],
      },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("No dispatch handler registered");
  });

  test("forwards input-level wait and timeout to handler context", async () => {
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    let handlerContext: { wait?: boolean; timeoutMs?: number } | undefined;
    runtime.register("resident.ask", (_command, context) => {
      handlerContext = { wait: context?.wait, timeoutMs: context?.timeoutMs };
      return { output: "ok" };
    });

    const result = await runtime.submit(
      {
        action: "resident.ask",
        target: { kind: "resident" },
        wait: true,
        timeoutMs: 1234,
      },
      {
        sessionId: "session-wait",
        runId: "run-wait",
        actorKind: "resident",
        actorId: "resident:main",
        policies: [allowDispatchPolicy()],
      },
    );

    expect(result.status).toBe("completed");
    expect(handlerContext).toEqual({ wait: true, timeoutMs: 1234 });
  });

  test("core treats handler payload opaquely", async () => {
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("custom.fake", (command) => ({ output: command.payload }));

    const payload = { workerLike: { lifecycle: "not-core-owned" } };
    const result = await runtime.submit(
      { action: "custom.fake", target: { kind: "system" }, payload },
      {
        sessionId: "session-opaque",
        runId: "run-opaque",
        actorKind: "system",
        actorId: "system:test",
        policies: [allowDispatchPolicy()],
      },
    );

    expect(result.status).toBe("completed");
    expect(result.output).toEqual(payload);
  });
});
