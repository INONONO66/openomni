import { describe, expect, test, beforeEach } from "bun:test";
import { Operational, PolicyDecision, type Dispatch as DispatchProtocol } from "@openomni/protocol";
import {
  BlacklistStore,
  Bus,
  PendingInteractionStore,
  Session,
  Storage,
  WorkerGrantStore,
  WorkerRun,
} from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";

const flushBus = () => new Promise((resolve) => queueMicrotask(resolve));

async function createWorkerRunFixture(runId = "run-1", sessionTitle = `${runId}-session`) {
  const session = Session.create({
    title: sessionTitle,
    model: { providerID: "test", modelID: "test" },
  });
  await WorkerRun.create(session.id, { runId, title: runId, prompt: "test" });
  return session;
}

function input(action = "resident.ask"): DispatchProtocol.Input {
  return { action, target: { kind: "resident" }, payload: "hello" };
}

describe("DispatchRuntime", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
  });

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
      { agentName: "resident", actorKind: "resident", actorId: "act_resident" },
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
      {},
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
    WorkerGrantStore.create({
      id: "grant-effective-worker-send",
      workerRunId: "run-1",
      allowedActions: ["worker.send"],
      allowedSessionIds: ["child-session"],
      canCreateExternalTasks: false,
    });

    const result = await runtime.submit(
      {
        action: "worker.send",
        target: { kind: "worker", sessionId: "child-session" },
        payload: "follow up",
      },
      { sessionId: "parent-session", runId: "run-1", agentName: "worker" },
    );

    const authority = decisions.find(
      (decision) => decision.policyId === "dispatch.default-authority",
    );
    expect(result.status).toBe("completed");
    expect(authority?.factsUsed).toContain("effective_authority.session_ownership_grant.allow");
    expect(authority?.factsUsed).toContain("worker_grant.allowed");
  });

  test("routes actor.message through a matching PendingInteraction before authorization", async () => {
    const decisions: PolicyDecision[] = [];
    const runtime = new DispatchRuntime({
      onPolicyDecision: (decision) => {
        decisions.push(decision);
      },
    });
    let routedCommand: DispatchProtocol.Command | undefined;
    runtime.register("worker.complete", (command) => {
      routedCommand = command;
      return { output: { routed: true, sessionId: command.sessionId, runId: command.runId } };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi");
    PendingInteractionStore.create({
      id: "pi-dispatch-1",
      workerRunId: "run-pi",
      sessionId: session.id,
      endpointId: "telegram:seller-1",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-1" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: {
          action: "report_result",
          result: {
            runId: "run-pi",
            sessionId: session.id,
            status: "succeeded",
            output: "SN-A2334",
            finishReason: "stop",
          },
        },
        correlation: {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          replyToMessageId: "message-out-1",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:seller-1",
      },
    );

    const authority = decisions.find(
      (decision) => decision.policyId === "dispatch.default-authority",
    );
    expect(result.status).toBe("completed");
    expect(result.handler).toBe("worker.complete");
    expect(routedCommand?.action).toBe("worker.complete");
    expect(routedCommand?.target).toMatchObject({
      kind: "worker",
      runId: "run-pi",
      sessionId: session.id,
    });
    expect(routedCommand?.actor.trustTier).toBe("assigned_worker");
    expect(PendingInteractionStore.get("pi-dispatch-1")?.status).toBe("resolved");
    expect(authority?.factsUsed).toContain("effective_authority.pending_interaction_scope.allow");
    expect(authority?.factsUsed).toContain("pending_interaction.pi-dispatch-1");
  });

  test("routes PendingInteraction clarification messages to resident.ask", async () => {
    const runtime = new DispatchRuntime();
    let routedCommand: DispatchProtocol.Command | undefined;
    runtime.register("resident.ask", (command) => {
      routedCommand = command;
      return { output: "resident answer" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-clarification");
    PendingInteractionStore.create({
      id: "pi-dispatch-clarification",
      workerRunId: "run-pi-clarification",
      sessionId: session.id,
      endpointId: "telegram:seller-clarification",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-clarification" },
      allowedActions: ["ask_clarification"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: { action: "ask_clarification", question: "Which branch should I use?" },
        correlation: {
          endpointId: "telegram:seller-clarification",
          channelId: "telegram:dm",
          replyToMessageId: "message-out-clarification",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:seller-clarification",
      },
    );

    expect(result.status).toBe("completed");
    expect(result.handler).toBe("resident.ask");
    expect(routedCommand?.action).toBe("resident.ask");
    expect(routedCommand?.target).toMatchObject({
      kind: "resident",
      sessionId: session.id,
    });
    expect(routedCommand?.wait).toBe(true);
    expect(routedCommand?.actor.trustTier).toBe("assigned_worker");
    expect(PendingInteractionStore.get("pi-dispatch-clarification")?.status).toBe("resolved");
  });

  test("denies unmatched actor.message from unknown actors", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.reply", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: "hello",
        correlation: {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          replyToMessageId: "unknown-message",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:seller-1",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.actor.required");
    expect(called).toBe(false);
  });

  test("denies unmatched actor.message even from otherwise trusted actors", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.message", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: "hello",
        correlation: {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          replyToMessageId: "unknown-message",
        },
      },
      {
        actorKind: "resident",
        actorId: "resident:main",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.pending_interaction.required");
    expect(called).toBe(false);
  });

  test("does not route actor.message when PendingInteraction disallows result reports", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.reply", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-disallowed");
    PendingInteractionStore.create({
      id: "pi-dispatch-disallowed",
      workerRunId: "run-pi-disallowed",
      sessionId: session.id,
      endpointId: "telegram:seller-2",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-2" },
      allowedActions: ["ask_clarification"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: "SN-A2334",
        correlation: {
          endpointId: "telegram:seller-2",
          channelId: "telegram:dm",
          replyToMessageId: "message-out-2",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:seller-2",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.actor.required");
    expect(PendingInteractionStore.get("pi-dispatch-disallowed")?.status).toBe("open");
    expect(called).toBe(false);
  });

  test("denies disallowed actor.message even from otherwise trusted actors", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.message", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-disallowed-trusted");
    PendingInteractionStore.create({
      id: "pi-dispatch-disallowed-trusted",
      workerRunId: "run-pi-disallowed-trusted",
      sessionId: session.id,
      endpointId: "telegram:seller-3",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-3" },
      allowedActions: ["ask_clarification"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: "SN-A2334",
        correlation: {
          endpointId: "telegram:seller-3",
          channelId: "telegram:dm",
          replyToMessageId: "message-out-3",
        },
      },
      {
        actorKind: "resident",
        actorId: "resident:main",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.pending_interaction.required");
    expect(PendingInteractionStore.get("pi-dispatch-disallowed-trusted")?.status).toBe("open");
    expect(called).toBe(false);
  });

  test("blocks blacklisted PendingInteraction endpoint matches before handler execution", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.reply", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    BlacklistStore.put({
      id: "bl-pi-endpoint",
      kind: "endpoint",
      value: "telegram:blocked-seller",
      reason: "blocked pending interaction endpoint",
      createdBy: "act_owner",
    });
    const session = await createWorkerRunFixture("run-pi-blacklisted-endpoint");
    PendingInteractionStore.create({
      id: "pi-dispatch-blacklisted-endpoint",
      workerRunId: "run-pi-blacklisted-endpoint",
      sessionId: session.id,
      endpointId: "telegram:blocked-seller",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-bl-endpoint" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: "SN-A2334",
        correlation: {
          endpointId: "telegram:blocked-seller",
          channelId: "telegram:dm",
          replyToMessageId: "message-out-bl-endpoint",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:blocked-seller",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("blocked pending interaction endpoint");
    expect(PendingInteractionStore.get("pi-dispatch-blacklisted-endpoint")?.status).toBe("open");
    expect(called).toBe(false);
  });

  test("blocks blacklisted PendingInteraction channel matches before handler execution", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.reply", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    BlacklistStore.put({
      id: "bl-pi-channel",
      kind: "channel",
      value: "telegram:blocked-dm",
      reason: "blocked pending interaction channel",
      createdBy: "act_owner",
    });
    const session = await createWorkerRunFixture("run-pi-blacklisted-channel");
    PendingInteractionStore.create({
      id: "pi-dispatch-blacklisted-channel",
      workerRunId: "run-pi-blacklisted-channel",
      sessionId: session.id,
      endpointId: "telegram:seller-4",
      channelId: "telegram:blocked-dm",
      correlation: { replyToMessageId: "message-out-bl-channel" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:blocked-dm" },
        payload: "SN-A2334",
        correlation: {
          endpointId: "telegram:seller-4",
          channelId: "telegram:blocked-dm",
          replyToMessageId: "message-out-bl-channel",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:seller-4",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("blocked pending interaction channel");
    expect(PendingInteractionStore.get("pi-dispatch-blacklisted-channel")?.status).toBe("open");
    expect(called).toBe(false);
  });

  test("denies forged direct actor.reply labels without a routed PendingInteraction match", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.reply", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-forged");
    PendingInteractionStore.create({
      id: "pi-dispatch-forged",
      workerRunId: "run-pi-forged",
      sessionId: session.id,
      endpointId: "telegram:seller-forged",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-forged" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.reply",
        target: { kind: "worker", runId: "run-pi-forged", sessionId: session.id },
        payload: "SN-A2334",
      },
      {
        actorKind: "worker",
        actorId: "telegram:seller-forged",
        sessionId: session.id,
        runId: "run-pi-forged",
        trustTier: "assigned_worker",
        labels: ["pending_interaction.pi-dispatch-forged"],
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.pending_interaction.match.required");
    expect(PendingInteractionStore.get("pi-dispatch-forged")?.status).toBe("open");
    expect(called).toBe(false);
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

  test("default policy allows worker spawning only with an explicit matching grant", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("worker.spawn", () => {
      called = true;
      return { output: "spawned" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-worker-spawn",
      workerRunId: "run-1",
      allowedActions: ["worker.spawn"],
      allowedSessionIds: ["parent-session"],
      canCreateExternalTasks: false,
    });

    const result = await runtime.submit(
      {
        action: "worker.spawn",
        target: { kind: "worker", parentSessionId: "parent-session" },
        payload: "delegated task",
      },
      { sessionId: "worker-session", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("completed");
    expect(result.output).toBe("spawned");
    expect(called).toBe(true);
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

  test("default policy requires grants for worker egress to existing scopes", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("worker.send", () => {
      called = true;
      return { output: "sent" };
    });

    const denied = await runtime.submit(
      {
        action: "worker.send",
        target: { kind: "worker", sessionId: "child-session" },
        payload: "follow up",
      },
      { sessionId: "parent-session", runId: "run-1", agentName: "worker" },
    );

    expect(denied.status).toBe("denied");
    expect(denied.reason).toBe("dispatch.worker.scope.denied");
    expect(called).toBe(false);

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-worker-send",
      workerRunId: "run-1",
      allowedActions: ["worker.send"],
      allowedSessionIds: ["child-session"],
      canCreateExternalTasks: false,
    });

    const allowed = await runtime.submit(
      {
        action: "worker.send",
        target: { kind: "worker", sessionId: "child-session" },
        payload: "follow up",
      },
      { sessionId: "parent-session", runId: "run-1", agentName: "worker" },
    );

    expect(allowed.status).toBe("completed");
    expect(allowed.output).toBe("sent");
    expect(called).toBe(true);
  });

  test("default policy lets workers ask resident without a grant", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("resident.ask", () => {
      called = true;
      return { output: "answer" };
    });

    const result = await runtime.submit(input("resident.ask"), {
      sessionId: "session-1",
      runId: "run-1",
      agentName: "worker",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("answer");
    expect(called).toBe(true);
  });

  test("default policy denies worker resident.ask to non-resident targets", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("resident.ask", () => {
      called = true;
      return { output: "should not route" };
    });

    const result = await runtime.submit(
      {
        action: "resident.ask",
        target: { kind: "worker", sessionId: "worker-session" },
        payload: "bypass attempt",
      },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.resident_ask.target.denied");
    expect(called).toBe(false);
  });

  test("default policy denies arbitrary worker dispatch actions fail-closed", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("system.shutdown", () => {
      called = true;
      return { output: "shutdown" };
    });

    const result = await runtime.submit(
      { action: "system.shutdown", target: { kind: "system" } },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.action.denied");
    expect(called).toBe(false);
  });

  test("default policy preserves WorkerGrant store errors as middleware audit evidence", async () => {
    let called = false;
    const warnings: unknown[] = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (data) => warnings.push(data));
    try {
      const runtime = new DispatchRuntime();
      runtime.register("api.ask", () => {
        called = true;
        return { output: "api answer" };
      });

      Storage.initialize({ dbPath: ":memory:" });
      const adapter = Storage.getAdapter();
      if (!adapter.workerGrant) throw new Error("workerGrant adapter missing in test setup");
      Storage.configure({
        ...adapter,
        workerGrant: {
          ...adapter.workerGrant,
          list: () => {
            throw new Error("worker grant adapter unavailable");
          },
        },
      });

      const result = await runtime.submit(
        {
          action: "api.ask",
          target: { kind: "external_actor", id: "api:research" },
        },
        { sessionId: "session-1", runId: "run-1", agentName: "worker" },
      );

      expect(result.status).toBe("denied");
      expect(result.reason).toBe("middleware-error");
      expect(called).toBe(false);
      expect(warnings).toContainEqual(
        expect.objectContaining({
          component: "agent.policy",
          msg: "middleware error",
          context: expect.objectContaining({
            name: "dispatch.default-authority",
            error: "Error: worker grant adapter unavailable",
            failPolicy: "fail-closed",
          }),
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  test("default policy requires manager grants for worker-created external tasks", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("api.ask", () => {
      called = true;
      return { output: "api answer" };
    });

    const denied = await runtime.submit(
      {
        action: "api.ask",
        target: { kind: "external_actor", id: "api:research" },
        payload: { question: "lookup" },
      },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(denied.status).toBe("denied");
    expect(denied.reason).toBe("dispatch.worker.external.denied");
    expect(called).toBe(false);

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-api-ask",
      workerRunId: "run-1",
      allowedActions: ["api.ask"],
      allowedEndpointIds: ["api:research"],
      canCreateExternalTasks: true,
    });

    const allowed = await runtime.submit(
      {
        action: "api.ask",
        target: { kind: "external_actor", id: "api:research" },
        payload: { question: "lookup" },
      },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(allowed.status).toBe("completed");
    expect(allowed.output).toBe("api answer");
    expect(called).toBe(true);
  });

  test("default policy denies worker external grants with empty endpoint scopes", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("api.ask", () => {
      called = true;
      return { output: "api answer" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-empty-endpoints",
      workerRunId: "run-1",
      allowedActions: ["api.ask"],
      allowedEndpointIds: [],
      canCreateExternalTasks: true,
    });

    const result = await runtime.submit(
      {
        action: "api.ask",
        target: { kind: "external_actor", id: "api:any" },
        payload: { question: "lookup" },
      },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.external.denied");
    expect(called).toBe(false);
  });

  test("default policy denies worker external grants when manager constraints need missing context", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("external.ask", () => {
      called = true;
      return { output: "external answer" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-manager-constrained",
      workerRunId: "run-1",
      allowedActions: ["external.ask"],
      allowedEndpointIds: ["human:advisor"],
      canCreateExternalTasks: true,
      managerGrant: { allowedActorGroups: ["design"], riskCeiling: "low" },
    });

    const result = await runtime.submit(
      {
        action: "external.ask",
        target: { kind: "external_actor", id: "human:advisor" },
      },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.external.denied");
    expect(called).toBe(false);
  });

  test("default policy does not trust target labels for manager-constrained worker grants", async () => {
    let called = false;
    const runtime = new DispatchRuntime();
    runtime.register("external.ask", () => {
      called = true;
      return { output: "external answer" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-manager-labels",
      workerRunId: "run-1",
      allowedActions: ["external.ask"],
      allowedEndpointIds: ["human:advisor"],
      canCreateExternalTasks: true,
      managerGrant: { allowedActorGroups: ["design"], riskCeiling: "low" },
    });

    const result = await runtime.submit(
      {
        action: "external.ask",
        target: {
          kind: "external_actor",
          id: "human:advisor",
          labels: ["actorGroup:design", "risk:low"],
        },
      },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.external.denied");
    expect(called).toBe(false);
  });

  test("worker grants do not allow new external tasks unless explicitly enabled", async () => {
    const runtime = new DispatchRuntime();
    runtime.register("external.ask", () => ({ output: "should not route" }));
    Storage.initialize({ dbPath: ":memory:" });
    await createWorkerRunFixture("run-1");
    WorkerGrantStore.create({
      id: "grant-external-followup",
      workerRunId: "run-1",
      allowedActions: ["external.ask"],
      allowedEndpointIds: ["human:advisor"],
      canCreateExternalTasks: false,
    });

    const result = await runtime.submit(
      {
        action: "external.ask",
        target: { kind: "external_actor", id: "human:advisor" },
      },
      { sessionId: "session-1", runId: "run-1", agentName: "worker" },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.worker.external.denied");
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
