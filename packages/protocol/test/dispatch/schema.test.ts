import { describe, expect, test } from "bun:test";
import { Dispatch, Policy, RuntimeResource } from "../../src/index.js";

const actor: Dispatch.ActorContext = {
  kind: "worker",
  actorId: "worker-1",
  agentName: "agent",
  sessionId: "session-1",
  runId: "run-1",
};

const target: Dispatch.Target = {
  kind: "resident",
  id: "resident-main",
  sessionId: "resident-session",
  parentSessionId: "parent-session",
};

const eventBase = {
  dispatchId: "dispatch-1",
  traceId: "trace-1",
  sessionId: "session-1",
  runId: "run-1",
  actor,
  action: "resident.ask",
  target,
  correlation: "corr-1",
  time: Date.now(),
};

describe("Dispatch protocol schemas", () => {
  test("Input accepts the public dispatch envelope", () => {
    const parsed = Dispatch.Input.parse({
      action: "resident.ask",
      target,
      payload: { message: "hello" },
      wait: true,
      timeoutMs: 1_000,
      correlation: "corr-1",
      idempotencyKey: "idem-1",
    });

    expect(parsed.action).toBe("resident.ask");
    expect(parsed.target.kind).toBe("resident");
    expect(parsed.target.parentSessionId).toBe("parent-session");
    expect(parsed.wait).toBe(true);
  });

  test("Input rejects actor and runtime-only fields", () => {
    for (const field of [
      "actor",
      "sessionId",
      "runId",
      "workspaceRoot",
      "model",
      "provider",
      "budget",
      "tools",
      "permissions",
      "owner",
      "ownerId",
      "dispatchOwners",
      "routeOwner",
      "resolveOwner",
    ]) {
      expect(
        Dispatch.Input.safeParse({
          action: "worker.spawn",
          target: { kind: "worker" },
          [field]: field === "actor" ? { actorId: "fake" } : "fake",
        }).success,
      ).toBe(false);
    }
  });

  test("ActorContext accepts runtime-derived actor shapes", () => {
    expect(Dispatch.ActorContext.parse(actor).kind).toBe("worker");
    expect(Dispatch.ActorContext.parse({ kind: "resident", actorId: "resident-main" }).kind).toBe(
      "resident",
    );
    expect(Dispatch.ActorContext.parse({ kind: "system", actorId: "scheduler" }).kind).toBe(
      "system",
    );
    expect(
      Dispatch.ActorContext.parse({ kind: "unknown", actorId: "unknown", reason: "missing" }).kind,
    ).toBe("unknown");
  });

  test("Command and Result carry canonical runtime metadata", () => {
    const command = Dispatch.Command.parse({
      action: "resident.ask",
      target,
      payload: { message: "hello" },
      dispatchId: "dispatch-1",
      actor,
      traceId: "trace-1",
      sessionId: "session-1",
      runId: "run-1",
      workspaceRoot: "/workspace",
      submittedAt: Date.now(),
    });

    expect(command.actor.actorId).toBe("worker-1");

    const result = Dispatch.Result.parse({
      dispatchId: command.dispatchId,
      status: "completed",
      output: { delivered: true },
      handler: "resident.ask",
      durationMs: 1,
    });

    expect(result.status).toBe("completed");
  });

  test("Events parse dispatch lifecycle payloads", () => {
    expect(Dispatch.Events.Submitted.schema.parse({ ...eventBase }).dispatchId).toBe("dispatch-1");
    expect(
      Dispatch.Events.Authorized.schema.parse({
        ...eventBase,
        verdict: "allow",
        policyId: "dispatch.default",
        effects: [{ type: "audit.annotate", annotation: "ok" }],
      }).verdict,
    ).toBe("allow");
    expect(
      Dispatch.Events.Denied.schema.parse({
        ...eventBase,
        verdict: "deny",
        reason: "not authorized",
        policyId: "dispatch.default",
      }).reason,
    ).toBe("not authorized");
    expect(
      Dispatch.Events.Routed.schema.parse({ ...eventBase, handler: "resident.ask" }).handler,
    ).toBe("resident.ask");
    expect(
      Dispatch.Events.Completed.schema.parse({
        ...eventBase,
        handler: "resident.ask",
        durationMs: 2,
      }).durationMs,
    ).toBe(2);
    expect(
      Dispatch.Events.Failed.schema.parse({ ...eventBase, reason: "handler failed" }).reason,
    ).toBe("handler failed");
  });

  test("Events use canonical descriptor names", () => {
    expect(Dispatch.Events.Submitted.name).toBe("dispatch.submitted");
    expect(Dispatch.Events.Authorized.name).toBe("dispatch.authorized");
    expect(Dispatch.Events.Denied.name).toBe("dispatch.denied");
    expect(Dispatch.Events.Routed.name).toBe("dispatch.routed");
    expect(Dispatch.Events.Completed.name).toBe("dispatch.completed");
    expect(Dispatch.Events.Failed.name).toBe("dispatch.failed");
  });

  test("RuntimeResource accepts dispatch descriptors for policy audit", () => {
    const descriptor = RuntimeResource.Descriptor.parse({
      id: "dispatch:resident.ask",
      kind: "dispatch",
      labels: ["dispatch.resident"],
      capabilities: ["resident.ask"],
      effects: ["message.deliver"],
      source: { type: "runtime", runtimeId: "dispatch-runtime" },
    });

    expect(descriptor.kind).toBe("dispatch");
  });

  test("Policy timing and point expose the canonical dispatch authority gate", () => {
    expect(Policy.Timing.DISPATCH_AUTHORIZE).toBe("dispatch.authorize");
    expect(Policy.PolicyPoint.MigrationMapping[Policy.Timing.DISPATCH_AUTHORIZE]).toEqual([
      "dispatch.action.pre",
    ]);

    const point = Policy.PolicyPoint.Registry["dispatch.action.pre"];
    expect(point.phase).toBe("pre");
    expect(point.defaultFailPolicy).toBe("fail-closed");
    expect(point.sideEffectBoundary).toBe(true);
    expect(point.requiredContext).toEqual([
      "actor",
      "dispatchId",
      "action",
      "target",
      "sessionId",
      "runId",
    ]);
    expect(point.allowedEffects).toEqual(["audit.annotate", "run.abort"]);
    expect(Policy.PolicyPoint.Id.parse("dispatch.action.pre")).toBe("dispatch.action.pre");
  });

  test("legacy policy mappings still resolve", () => {
    expect(Policy.PolicyPoint.resolve(Policy.Timing.INBOUND_RECEIVE)).toEqual([
      "session.inbound.pre",
    ]);
    expect(
      Policy.PolicyPoint.resolve(Policy.Timing.INVOKE_PREPARE, { resourceKind: "tool" }),
    ).toEqual(["tool.native.pre", "tool.mcp.pre"]);
    expect(Policy.PolicyPoint.resolve(Policy.Timing.WRITEBACK_COMMIT)).toEqual([
      "session.writeback.pre",
    ]);
  });
});
