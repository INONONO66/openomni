import { describe, expect, test } from "bun:test";
import { Command, Policy } from "../../src/index.js";

const actor: Command.ActorContext = {
  kind: "worker",
  actorId: "worker-1",
  agentName: "agent",
  sessionId: "session-1",
  runId: "run-1",
};

const target: Command.Target = {
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

describe("Command protocol schemas", () => {
  test("Input accepts the public dispatch envelope", () => {
    const parsed = Command.Input.parse({
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

  test("Target accepts connector endpoint selectors for worker admission", () => {
    const parsed = Command.Target.parse({
      kind: "worker",
      name: "coder",
      endpointId: "endpoint:install-app-codex",
      connectorInstallationId: "install:app.example-worker",
    });

    expect(parsed.endpointId).toBe("endpoint:install-app-codex");
    expect(parsed.connectorInstallationId).toBe("install:app.example-worker");
  });

  test("Target rejects executorKind as a public dispatch selector", () => {
    const parsed = Command.Target.safeParse({
      kind: "worker",
      name: "coder",
      executorKind: "connector_endpoint",
    });

    expect(parsed.success).toBe(false);
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
        Command.Input.safeParse({
          action: "worker.spawn",
          target: { kind: "worker" },
          [field]: field === "actor" ? { actorId: "fake" } : "fake",
        }).success,
      ).toBe(false);
    }
  });

  test("ActorContext accepts runtime-derived actor shapes", () => {
    expect(Command.ActorContext.parse(actor).kind).toBe("worker");
    expect(Command.ActorContext.parse({ kind: "resident", actorId: "resident-main" }).kind).toBe(
      "resident",
    );
    expect(Command.ActorContext.parse({ kind: "system", actorId: "scheduler" }).kind).toBe(
      "system",
    );
    expect(
      Command.ActorContext.parse({ kind: "unknown", actorId: "unknown", reason: "missing" }).kind,
    ).toBe("unknown");
  });

  test("Request and Result carry canonical runtime metadata", () => {
    const command = Command.Request.parse({
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

    const result = Command.Result.parse({
      dispatchId: command.dispatchId,
      status: "completed",
      output: { delivered: true },
      handler: "resident.ask",
      durationMs: 1,
    });

    expect(result.status).toBe("completed");
  });

  test("Events parse dispatch lifecycle payloads", () => {
    expect(Command.Events.Submitted.schema.parse({ ...eventBase }).dispatchId).toBe("dispatch-1");
    expect(
      Command.Events.Authorized.schema.parse({
        ...eventBase,
        verdict: "allow",
        policyId: "dispatch.default",
        effects: [{ type: "audit.annotate", annotation: "ok" }],
      }).verdict,
    ).toBe("allow");
    expect(
      Command.Events.Denied.schema.parse({
        ...eventBase,
        verdict: "deny",
        reason: "not authorized",
        policyId: "dispatch.default",
      }).reason,
    ).toBe("not authorized");
    expect(
      Command.Events.Routed.schema.parse({ ...eventBase, handler: "resident.ask" }).handler,
    ).toBe("resident.ask");
    expect(
      Command.Events.Completed.schema.parse({
        ...eventBase,
        handler: "resident.ask",
        durationMs: 2,
      }).durationMs,
    ).toBe(2);
    expect(
      Command.Events.Failed.schema.parse({ ...eventBase, reason: "handler failed" }).reason,
    ).toBe("handler failed");
  });

  test("Events refuse an untraced payload", () => {
    // Pin (D11): Command.traceId is required and submit hard-rejects a missing
    // one, so the field is enforced at COMPILE time for every typed producer.
    // Persistence does not strict-parse (it keeps the raw payload and files it
    // under the "untraced" sentinel); the schema states the invariant so any
    // future strict consumer refuses. Two events suffice: all six extend the
    // one EventBase and none re-declares traceId.
    const { traceId: _traceId, ...untraced } = eventBase;
    expect(Command.Events.Submitted.schema.safeParse(untraced).success).toBe(false);
    expect(
      Command.Events.Failed.schema.safeParse({ ...untraced, reason: "handler failed" }).success,
    ).toBe(false);
  });

  test("Events use canonical descriptor names", () => {
    expect(Command.Events.Submitted.name).toBe("dispatch.submitted");
    expect(Command.Events.Authorized.name).toBe("dispatch.authorized");
    expect(Command.Events.Denied.name).toBe("dispatch.denied");
    expect(Command.Events.Routed.name).toBe("dispatch.routed");
    expect(Command.Events.Completed.name).toBe("dispatch.completed");
    expect(Command.Events.Failed.name).toBe("dispatch.failed");
  });

  test("Policy.Resource accepts dispatch descriptors for policy audit", () => {
    const descriptor = Policy.Resource.Descriptor.parse({
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

    const point = Policy.PolicyPoint.Registry["dispatch.action.pre"];
    expect(point.phase).toBe("pre");
    expect(point.defaultFailPolicy).toBe("fail-closed");
    expect(point.sideEffectBoundary).toBe(true);
    expect(point.requiredContext).toEqual(["actor", "dispatchId", "action", "target"]);
    expect(point.allowedEffects).toEqual(["audit.annotate", "run.abort"]);
    expect(Policy.PolicyPoint.Id.parse("dispatch.action.pre")).toBe("dispatch.action.pre");
  });
});
