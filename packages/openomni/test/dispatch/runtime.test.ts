import { describe, expect, test, beforeEach } from "bun:test";
import { PolicyDecision, type Dispatch as DispatchProtocol } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";

const flushBus = () => new Promise((resolve) => queueMicrotask(resolve));

function input(action = "resident.deliver"): DispatchProtocol.Input {
  return { action, target: { kind: "resident" }, payload: "hello" };
}

describe("DispatchRuntime", () => {
  beforeEach(() => {
    Bus.reset();
  });

  test("authorizes before routing and completes a handler", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    let called = false;
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("resident.deliver", async () => {
      called = true;
      return { output: "ok" };
    });

    const result = await runtime.submit(input(), {
      sessionId: "session-1",
      runId: "run-1",
      agentName: "resident",
      policies: [
        {
          name: "allow-dispatch",
          timing: "dispatch.authorize",
          priority: 0,
          fn: () => PolicyDecision.allow({ policyId: "allow-dispatch" }),
        },
      ],
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
          name: "deny-dispatch",
          timing: "dispatch.authorize",
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

  test("default policy denies worker spawning independent work", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("worker.spawn", () => {
      called = true;
      return { output: "spawned" };
    });

    const result = await runtime.submit(input("worker.spawn"), {
      sessionId: "session-1",
      runId: "run-1",
      agentName: "worker",
    });

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.spawn.denied");
    expect(called).toBe(false);
  });

  test("default policy denies worker schedule creation", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("schedule.create", () => {
      called = true;
      return { output: "scheduled" };
    });

    const result = await runtime.submit(
      { action: "schedule.create", target: { kind: "schedule", name: "resident" } },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.schedule.denied");
    expect(called).toBe(false);
  });

  test("default policy denies unknown actors before custom action routing", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("custom.echo", () => {
      called = true;
      return { output: "echo" };
    });

    const result = await runtime.submit(
      { action: "custom.echo", target: { kind: "system" }, payload: "secret text" },
      {},
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.actor.required");
    expect(called).toBe(false);
  });

  test("rejects duplicate handler registrations", () => {
    const runtime = new DispatchRuntime();
    runtime.register("resident.deliver", () => ({ output: "first" }));

    expect(() => runtime.register("resident.deliver", () => ({ output: "second" }))).toThrow(
      "dispatch action already registered: resident.deliver",
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
    runtime.register("resident.deliver", () => ({ output: "private output" }));

    await runtime.submit(
      {
        action: "resident.deliver",
        target: { kind: "resident" },
        payload: "private input",
      },
      {
        actorKind: "resident",
        actorId: "resident:main",
        policies: [
          {
            name: "allow-dispatch",
            timing: "dispatch.authorize",
            priority: 0,
            fn: () => PolicyDecision.allow({ policyId: "allow-dispatch" }),
          },
        ],
      },
    );

    expect(payloads.some((payload) => "payloadSummary" in payload)).toBe(false);
    expect(payloads.some((payload) => "resultSummary" in payload)).toBe(false);
  });

  test("fails unknown action without routing", async () => {
    const result = await new DispatchRuntime({ includeDefaultPolicies: false }).submit(
      { action: "custom.missing", target: { kind: "system" } },
      {
        actorKind: "system",
        actorId: "system:test",
        policies: [
          {
            name: "allow-dispatch",
            timing: "dispatch.authorize",
            priority: 0,
            fn: () => PolicyDecision.allow({ policyId: "allow-dispatch" }),
          },
        ],
      },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("No dispatch handler registered");
  });

  test("core treats handler payload opaquely", async () => {
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("custom.fake", (command) => ({ output: command.payload }));

    const payload = { workerLike: { lifecycle: "not-core-owned" } };
    const result = await runtime.submit(
      { action: "custom.fake", target: { kind: "system" }, payload },
      {
        actorKind: "system",
        actorId: "system:test",
        policies: [
          {
            name: "allow-dispatch",
            timing: "dispatch.authorize",
            priority: 0,
            fn: () => PolicyDecision.allow({ policyId: "allow-dispatch" }),
          },
        ],
      },
    );

    expect(result.status).toBe("completed");
    expect(result.output).toEqual(payload);
  });
});
