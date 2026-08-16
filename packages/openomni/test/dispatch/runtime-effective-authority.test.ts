import { beforeEach, describe, expect, test } from "bun:test";
import type { PolicyDecision } from "@openomni/protocol";
import { BlacklistStore, Storage, WorkerGrantStore } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import { createWorkerRunFixture, input, resetDispatchTestState } from "./runtime-test-fixtures";

/** A dispatch inherits the trace of whatever ordered it; the runtime refuses to mint one. */
const TEST_DISPATCH_TRACE_ID = "trace-dispatch-test";

describe("DispatchRuntime", () => {
  beforeEach(resetDispatchTestState);

  test("default policy blocks blacklisted external targets before routing", async () => {
    const decisions: PolicyDecision[] = [];
    Storage.initialize({ dbPath: ":memory:" });
    BlacklistStore.put({
      id: "bl-endpoint",
      kind: "endpoint",
      value: "ep_blocked",
      reason: "blocked endpoint",
      createdBy: "act_owner",
    });
    let called = false;
    const runtime = new DispatchRuntime({
      onPolicyDecision: (decision) => {
        decisions.push(decision);
      },
    });
    runtime.register("external.ask", () => {
      called = true;
      return { output: "sent" };
    });

    const result = await runtime.submit(
      {
        action: "external.ask",
        target: { kind: "external_actor", id: "ep_blocked" },
        payload: "hello",
      },
      {
        traceId: TEST_DISPATCH_TRACE_ID,
        sessionId: "session-blacklist",
        runId: "run-blacklist",
        agentName: "resident",
        actorKind: "resident",
        actorId: "act_resident",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("blocked endpoint");
    expect(called).toBe(false);
    const authority = decisions.find(
      (decision) => decision.policyId === "dispatch.default-authority",
    );
    expect(authority?.factsUsed).toContain("effective_authority.blacklist.deny");
    expect(authority?.factsUsed).toContain("effective_authority.channel_grant.not_required");
    expect(authority?.factsUsed).toContain(
      "effective_authority.personal_or_channel_default_grant.not_required",
    );
    expect(authority?.factsUsed).toContain(
      "effective_authority.session_ownership_grant.not_required",
    );
    expect(authority?.factsUsed).toContain(
      "effective_authority.pending_interaction_scope.not_required",
    );
  });

  test("default policy records effective authority axes for allowed resident dispatch", async () => {
    const decisions: PolicyDecision[] = [];
    const runtime = new DispatchRuntime({
      onPolicyDecision: (decision) => {
        decisions.push(decision);
      },
    });
    runtime.register("resident.ask", () => ({ output: "answer" }));

    const result = await runtime.submit(input("resident.ask"), {
      traceId: TEST_DISPATCH_TRACE_ID,
      sessionId: "session-1",
      runId: "run-1",
      actorKind: "resident",
      actorId: "resident:main",
      trustTier: "manager",
    });

    const authority = decisions.find(
      (decision) => decision.policyId === "dispatch.default-authority",
    );
    expect(result.status).toBe("completed");
    expect(authority?.factsUsed).toContain("effective_authority.blacklist.allow");
    expect(authority?.factsUsed).toContain(
      "effective_authority.personal_or_channel_default_grant.allow",
    );
    expect(authority?.factsUsed).toContain("effective_authority.channel_grant.not_required");
    expect(authority?.factsUsed).toContain(
      "effective_authority.session_ownership_grant.not_required",
    );
    expect(authority?.factsUsed).toContain(
      "effective_authority.pending_interaction_scope.not_required",
    );
  });

  test("default policy records effective authority denial axis for unknown actors", async () => {
    const decisions: PolicyDecision[] = [];
    let called = false;
    const runtime = new DispatchRuntime({
      onPolicyDecision: (decision) => {
        decisions.push(decision);
      },
    });
    runtime.register("custom.echo", () => {
      called = true;
      return { output: "echo" };
    });

    const result = await runtime.submit(
      { action: "custom.echo", target: { kind: "system" }, payload: "secret text" },
      { traceId: TEST_DISPATCH_TRACE_ID, sessionId: "session-unknown", runId: "run-unknown" },
    );

    const authority = decisions.find(
      (decision) => decision.policyId === "dispatch.default-authority",
    );
    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.actor.required");
    expect(called).toBe(false);
    expect(authority?.factsUsed).toContain(
      "effective_authority.personal_or_channel_default_grant.deny",
    );
  });

  test("default policy records worker grant as the session ownership authority axis", async () => {
    const decisions: PolicyDecision[] = [];
    const runtime = new DispatchRuntime({
      onPolicyDecision: (decision) => {
        decisions.push(decision);
      },
    });
    runtime.register("worker.send", () => ({ output: "sent" }));

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create(
      {
        id: "grant-effective-worker-send",
        workerRunId: "run-1",
        allowedActions: ["worker.send"],
        allowedSessionIds: ["child-session"],
        canCreateExternalTasks: false,
      },
      TEST_DISPATCH_TRACE_ID,
    );

    const result = await runtime.submit(
      {
        action: "worker.send",
        target: { kind: "worker", sessionId: "child-session" },
        payload: "follow up",
      },
      {
        traceId: TEST_DISPATCH_TRACE_ID,
        sessionId: "parent-session",
        runId: "run-1",
        agentName: "worker",
      },
    );

    const authority = decisions.find(
      (decision) => decision.policyId === "dispatch.default-authority",
    );
    expect(result.status).toBe("completed");
    expect(authority?.factsUsed).toContain("effective_authority.session_ownership_grant.allow");
    expect(authority?.factsUsed).toContain("worker_grant.allowed");
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
      {
        traceId: TEST_DISPATCH_TRACE_ID,
        sessionId: "session-unknown-action",
        runId: "run-unknown-action",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.actor.required");
    expect(called).toBe(false);
  });
});
