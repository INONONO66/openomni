import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { Bus, Session, Storage, WorkerGrantStore, WorkerRun } from "@openomni/session";
import type { PolicyRegistration } from "@openomni/agent";
import {
  applyPreDelegationDecision,
  dispatchPreDelegation,
} from "../../src/subagent/runtime-admission";

describe("dispatchPreDelegation fail-closed admission", () => {
  test("resident top-level spawn with no middleware is allowed", async () => {
    const decision = await dispatchPreDelegation({
      middleware: [],
      parentSessionId: undefined,
      childAgent: "worker",
      operation: "spawn",
      prompt: "do work",
    });

    expect(decision.verdict).toBe("allow");
    expect(decision.reasonCodes).toContain("resident-spawn-allowed");
    expect(PolicyDecision.isBlocking(decision)).toBe(false);
  });

  test("worker spawn with no middleware is denied with a run.abort effect", async () => {
    const decision = await dispatchPreDelegation({
      middleware: [],
      parentSessionId: "some-session-id",
      childAgent: "worker",
      operation: "spawn",
      prompt: "do work",
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("no-middleware-registered");
    expect(PolicyDecision.isBlocking(decision)).toBe(true);
    expect(decision.effects).toContainEqual({
      type: "run.abort",
      reason: "worker spawn requires delegation middleware",
    });
  });

  test("applyPreDelegationDecision throws for worker deny but not for resident allow", async () => {
    const residentDecision = await dispatchPreDelegation({
      middleware: [],
      parentSessionId: undefined,
      childAgent: "worker",
      operation: "spawn",
      prompt: "do work",
    });
    expect(() => applyPreDelegationDecision({}, residentDecision, "fallback")).not.toThrow();

    const workerDecision = await dispatchPreDelegation({
      middleware: [],
      parentSessionId: "some-session-id",
      childAgent: "worker",
      operation: "spawn",
      prompt: "do work",
    });
    expect(() => applyPreDelegationDecision({}, workerDecision, "fallback")).toThrow(
      "no-middleware-registered",
    );
  });
});

const allowDelegation: PolicyRegistration = {
  name: "test:allow-delegation",
  timing: "invoke.prepare",
  priority: 0,
  fn: () => PolicyDecision.allow({ policyId: "test:allow-delegation" }),
};

describe("dispatchPreDelegation WorkerGrantStore enforcement", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
  });

  afterEach(() => {
    Bus.reset();
    Storage.reset();
  });

  test("worker spawn without grant record is denied on in-process path (a)", async () => {
    const decision = await dispatchPreDelegation({
      middleware: [allowDelegation],
      parentSessionId: "parent-session-123",
      workerRunId: "worker-run-456",
      childAgent: "worker",
      operation: "spawn",
      prompt: "do work",
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("worker-grant.denied");
    expect(decision.reasonCodes).toContain("worker_grant.no_matching_grant");
    expect(PolicyDecision.isBlocking(decision)).toBe(true);
    expect(decision.effects).toContainEqual({
      type: "run.abort",
      reason: "worker_grant.no_matching_grant",
    });
  });

  test("worker send without grant record is denied on in-process path (a)", async () => {
    const decision = await dispatchPreDelegation({
      middleware: [allowDelegation],
      parentSessionId: "parent-session-123",
      workerRunId: "worker-run-456",
      childAgent: "worker",
      operation: "send",
      prompt: "send work",
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("worker-grant.denied");
    expect(decision.reasonCodes).toContain("worker_grant.no_matching_grant");
    expect(PolicyDecision.isBlocking(decision)).toBe(true);
  });

  test("worker spawn with valid grant passes authority check and reaches middleware", async () => {
    const parentSessionId = Session.create({
      title: "parent",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    }).id;
    const workerSession = Session.createChild({
      parentSessionId,
      title: "worker",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    });
    const workerRunId = crypto.randomUUID();
    await WorkerRun.create(workerSession.id, { runId: workerRunId, title: "task", prompt: "do" });

    WorkerGrantStore.create({
      id: "grant-001",
      workerRunId,
      allowedActions: ["worker.spawn"],
      allowedSessionIds: [parentSessionId],
      canCreateExternalTasks: false,
    });

    const decision = await dispatchPreDelegation({
      middleware: [allowDelegation],
      parentSessionId,
      workerRunId,
      childAgent: "worker",
      operation: "spawn",
      prompt: "do work",
    });

    expect(decision.verdict).toBe("allow");
    expect(PolicyDecision.isBlocking(decision)).toBe(false);
  });

  test("worker spawn with grant for wrong action is denied", async () => {
    const parentSessionId = Session.create({
      title: "parent",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    }).id;
    const workerSession = Session.createChild({
      parentSessionId,
      title: "worker",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    });
    const workerRunId = crypto.randomUUID();
    await WorkerRun.create(workerSession.id, { runId: workerRunId, title: "task", prompt: "do" });

    WorkerGrantStore.create({
      id: "grant-002",
      workerRunId,
      allowedActions: ["worker.send"],
      canCreateExternalTasks: false,
    });

    const decision = await dispatchPreDelegation({
      middleware: [allowDelegation],
      parentSessionId,
      workerRunId,
      childAgent: "worker",
      operation: "spawn",
      prompt: "do work",
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("worker-grant.denied");
    expect(decision.reasonCodes).toContain("worker_grant.action.denied");
    expect(PolicyDecision.isBlocking(decision)).toBe(true);
  });
});
