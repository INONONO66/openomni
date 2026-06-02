import { describe, expect, test } from "bun:test";
import { Ipc } from "../../src/index.js";

describe("Ipc.Request", () => {
  test("parse round-trip", () => {
    const raw = {
      v: 2,
      type: "request",
      id: "req-1",
      method: "worker.ready",
      params: { workerId: "w1", pid: 1234 },
    };
    const parsed = Ipc.Request.parse(raw);
    const reparsed = Ipc.Request.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  test("rejects missing id", () => {
    expect(Ipc.Request.safeParse({ v: 2, type: "request", method: "worker.ready" }).success).toBe(
      false,
    );
  });

  test("rejects wrong version", () => {
    expect(
      Ipc.Request.safeParse({
        v: 1,
        type: "request",
        id: "req-1",
        method: "worker.ready",
      }).success,
    ).toBe(false);
  });

  test("rejects wrong type", () => {
    expect(
      Ipc.Request.safeParse({
        v: 2,
        type: "notification",
        id: "req-1",
        method: "worker.ready",
      }).success,
    ).toBe(false);
  });
});

describe("Ipc.Response", () => {
  test("parse round-trip with result", () => {
    const raw = { v: 2, type: "response", id: "req-1", result: { accepted: true } };
    const parsed = Ipc.Response.parse(raw);
    const reparsed = Ipc.Response.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  test("parse round-trip with error", () => {
    const raw = {
      v: 2,
      type: "response",
      id: "req-1",
      error: { code: 2000, message: "method not found" },
    };
    const parsed = Ipc.Response.parse(raw);
    const reparsed = Ipc.Response.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  test("rejects missing id", () => {
    expect(Ipc.Response.safeParse({ v: 2, type: "response", result: null }).success).toBe(false);
  });
});

describe("Ipc.Notification", () => {
  test("parse round-trip", () => {
    const raw = {
      v: 2,
      type: "notification",
      method: "worker.state_update",
      params: { runId: "run-1", sessionId: "sess-1", event: "turn_start" },
    };
    const parsed = Ipc.Notification.parse(raw);
    const reparsed = Ipc.Notification.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  test("rejects missing method", () => {
    expect(Ipc.Notification.safeParse({ v: 2, type: "notification" }).success).toBe(false);
  });
});

describe("Ipc helpers", () => {
  test("createRequest produces valid request", () => {
    const req = Ipc.createRequest("worker.ready", { workerId: "w1", pid: 42 });
    expect(Ipc.Request.safeParse(req).success).toBe(true);
    expect(req.type).toBe("request");
    expect(req.v).toBe(2);
    expect(typeof req.id).toBe("string");
    expect(req.method).toBe("worker.ready");
  });

  test("createRequest without params", () => {
    const req = Ipc.createRequest("coordinator.cancel_run");
    expect(Ipc.Request.safeParse(req).success).toBe(true);
    expect(req.params).toBe(undefined);
  });

  test("createResponse produces valid response", () => {
    const res = Ipc.createResponse("req-1", { accepted: true });
    expect(Ipc.Response.safeParse(res).success).toBe(true);
    expect(res.type).toBe("response");
    expect(res.id).toBe("req-1");
    expect(res.result).toEqual({ accepted: true });
  });

  test("createErrorResponse produces valid error response", () => {
    const res = Ipc.createErrorResponse("req-1", 2000, "method not found");
    expect(Ipc.Response.safeParse(res).success).toBe(true);
    expect(res.error?.code).toBe(2000);
    expect(res.error?.message).toBe("method not found");
    expect(res.result).toBe(undefined);
  });

  test("createNotification produces valid notification", () => {
    const notif = Ipc.createNotification("worker.state_update", {
      runId: "run-1",
      sessionId: "sess-1",
      event: "turn_end",
    });
    expect(Ipc.Notification.safeParse(notif).success).toBe(true);
    expect(notif.type).toBe("notification");
    expect(notif.method).toBe("worker.state_update");
  });

  test("createNotification without params", () => {
    const notif = Ipc.createNotification("ping");
    expect(Ipc.Notification.safeParse(notif).success).toBe(true);
    expect(notif.params).toBe(undefined);
  });
});

describe("Ipc.Methods param schemas", () => {
  test("coordinator.spawn_run params valid", () => {
    expect(
      Ipc.Methods["coordinator.spawn_run"].params.safeParse({
        authToken: "token",
        runId: "run-1",
        sessionId: "sess-1",
        prompt: "do work",
        model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
        credentials: { ANTHROPIC_API_KEY: "sk-test" },
        permissions: {
          action: "tool.call",
          allowlist: ["read_file"],
          denyLabels: ["risk.tier-3"],
          inputRules: [
            {
              toolPattern: "write_file",
              field: "path",
              pattern: "^/workspace/",
              action: "allow",
            },
          ],
        },
        policyPlan: {
          policies: [{ id: "builtin:tool-permission", required: true }],
          labels: ["ipc"],
        },
      }).success,
    ).toBe(true);
  });

  test("coordinator.spawn_run preserves policy plans", () => {
    const parsed = Ipc.Methods["coordinator.spawn_run"].params.parse({
      authToken: "token",
      runId: "run-1",
      sessionId: "sess-1",
      prompt: "do work",
      model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
      policyPlan: {
        policies: [{ id: "builtin:tool-permission", required: true }],
        labels: ["ipc"],
      },
    });

    expect(parsed.policyPlan?.labels).toEqual(["ipc"]);
    expect(parsed.policyPlan?.policies[0]?.id).toBe("builtin:tool-permission");
  });

  test("coordinator.spawn_run rejects permission payloads without canonical action", () => {
    expect(
      Ipc.Methods["coordinator.spawn_run"].params.safeParse({
        authToken: "token",
        runId: "run-1",
        sessionId: "sess-1",
        prompt: "do work",
        model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
        permissions: {
          allowlist: ["read_file"],
        },
      }).success,
    ).toBe(false);
  });

  test("coordinator.spawn_run rejects missing required fields", () => {
    expect(
      Ipc.Methods["coordinator.spawn_run"].params.safeParse({
        runId: "run-1",
        prompt: "do work",
      }).success,
    ).toBe(false);
  });

  test("worker.run_completed params valid", () => {
    expect(
      Ipc.Methods["worker.run_completed"].params.safeParse({
        runId: "run-1",
        sessionId: "sess-1",
        status: "succeeded",
        output: "done",
      }).success,
    ).toBe(true);
  });

  test("worker.run_completed rejects invalid status", () => {
    expect(
      Ipc.Methods["worker.run_completed"].params.safeParse({
        runId: "run-1",
        sessionId: "sess-1",
        status: "unknown",
      }).success,
    ).toBe(false);
  });

  test("worker.heartbeat params valid", () => {
    expect(
      Ipc.Methods["worker.heartbeat"].params.safeParse({
        authToken: "token",
        workerId: "w1",
        activeRunIds: ["run-1", "run-2"],
        memoryRssMb: 256,
      }).success,
    ).toBe(true);
  });

  test("worker.inbound_wait params valid", () => {
    expect(
      Ipc.Methods["worker.inbound_wait"].params.safeParse({
        authToken: "token",
        workerId: "worker-1",
        sessionId: "session-1",
        runId: "run-1",
        callId: "call-1",
        payload: "Need approval",
        workspaceRoot: "/workspace/openomni",
      }).success,
    ).toBe(true);
  });

  test("worker.inbound_wait_cancel params valid", () => {
    expect(
      Ipc.Methods["worker.inbound_wait_cancel"].params.safeParse({
        sessionId: "session-1",
        runId: "run-1",
        callId: "call-1",
      }).success,
    ).toBe(true);
  });

  test("worker.tool_call_settled accepts optional auth token for version-skew tolerance", () => {
    expect(
      Ipc.Methods["worker.tool_call_settled"].params.safeParse({
        authToken: "token",
        callId: "call-1",
        workspaceRoot: "/workspace",
      }).success,
    ).toBe(true);

    expect(
      Ipc.Methods["worker.tool_call_settled"].params.safeParse({
        callId: "call-1",
        workspaceRoot: "/workspace",
      }).success,
    ).toBe(true);
  });
});
