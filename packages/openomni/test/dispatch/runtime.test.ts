import { describe, expect, test, beforeEach } from "bun:test";

const flushBus = () => new Promise((resolve) => queueMicrotask(resolve));
import { PolicyDecision, type Dispatch as DispatchProtocol } from "../../../protocol/src/index";
import { Bus } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";

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
