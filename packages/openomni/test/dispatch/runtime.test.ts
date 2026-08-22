import { beforeEach, describe, expect, test } from "bun:test";
import { Ledger, PolicyDecision } from "@openomni/protocol";
import { Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { CommandRecordError, DispatchRuntime } from "../../src/dispatch/runtime";
import {
  allowDispatchPolicy,
  flushBus,
  input,
  resetDispatchTestState,
} from "./runtime-test-fixtures";

/** A dispatch inherits the trace of whatever ordered it; the runtime refuses to mint one. */
const TEST_DISPATCH_TRACE_ID = "trace-dispatch-test";

describe("DispatchRuntime", () => {
  /**
   * A dispatch is ordered by something that already has a trace. The type
   * makes this unreachable for a typed caller; the throw stands for the
   * untyped ones — `Reflect.apply` and JSON-shaped IPC params — which is
   * exactly how the round-7 defect reached `submit`.
   */
  test("refuses a submit that cannot name its ordering run", async () => {
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    let handlerCalled = false;
    runtime.register("resident.ask", () => {
      handlerCalled = true;
      return { output: "must not run" };
    });

    const submission: Promise<unknown> = Reflect.apply(runtime.submit, runtime, [
      { action: "resident.ask", target: { kind: "resident" }, payload: "hello" },
      { sessionId: "session-traceless", runId: "run-traceless" },
    ]);

    await expect(submission).rejects.toThrow("dispatch submit requires the ordering run's traceId");
    expect(handlerCalled).toBe(false);
  });
  beforeEach(resetDispatchTestState);

  test("authorizes before routing and completes a handler", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    let called = false;
    let factAtHandler: unknown;
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("resident.ask", async (command) => {
      called = true;
      factAtHandler = Storage.get().ledger?.headFact(`command:${command.dispatchId}`);
      return { output: "ok" };
    });

    const result = await runtime.submit(input(), {
      traceId: TEST_DISPATCH_TRACE_ID,
      sessionId: "session-1",
      runId: "run-1",
      agentName: "resident",
      policies: [allowDispatchPolicy()],
    });

    await flushBus();
    expect(result.status).toBe("completed");
    expect(result.output).toBe("ok");
    expect(called).toBe(true);
    expect(factAtHandler).toMatchObject({ seq: 1, type: "command.authorized" });
    expect(
      Ledger.CommandAuthorized.safeParse((factAtHandler as { data: unknown }).data).success,
    ).toBe(true);
    expect(Storage.get().ledger?.headFact(`command:${result.dispatchId}`)?.seq).toBe(1);
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
      traceId: TEST_DISPATCH_TRACE_ID,
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
    expect(Storage.get().ledger?.headFact(`command:${result.dispatchId}`)).toMatchObject({
      seq: 1,
      type: "command.denied",
    });
    expect(events).toContain("dispatch.denied");
    expect(events).not.toContain("dispatch.routed");
  });

  test.each([
    "throw",
    "conflict",
  ] as const)("ledger %s fails closed as command_record_failed without handler or projection", async (failure) => {
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    let calls = 0;
    runtime.register("resident.ask", () => {
      calls += 1;
      return { output: "must not run" };
    });
    const adapter = Storage.getAdapter();
    const ledger = adapter.ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    Storage.configure({
      ...adapter,
      transaction: adapter.transaction.bind(adapter),
      ledger: {
        ...ledger,
        append: () => {
          if (failure === "throw") throw new Error("ledger unavailable");
          return { kind: "cas_conflict", currentHead: 1 } as const;
        },
      },
    });
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    let thrown: unknown;
    try {
      await runtime.submit(input(), {
        traceId: TEST_DISPATCH_TRACE_ID,
        sessionId: "session-1",
        runId: "run-1",
        agentName: "resident",
        policies: [allowDispatchPolicy()],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CommandRecordError);
    expect((thrown as CommandRecordError).code).toBe("command_record_failed");
    expect(calls).toBe(0);
    await flushBus();
    expect(events).not.toContain("dispatch.authorized");
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
        traceId: TEST_DISPATCH_TRACE_ID,
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
        traceId: TEST_DISPATCH_TRACE_ID,
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
        traceId: TEST_DISPATCH_TRACE_ID,
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
        traceId: TEST_DISPATCH_TRACE_ID,
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
