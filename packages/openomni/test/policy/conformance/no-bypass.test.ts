import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { PolicyRegistration } from "@openomni/agent";
import type { Ingress } from "@openomni/protocol";
import { Bus, Session, Storage } from "@openomni/session";
import { IngressEngine } from "../../../src/ingress/engine";
import { BackgroundManager } from "../../../src/subagent/background-manager";
import { SubagentRuntime } from "../../../src/subagent/runtime";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

function denyAll(reason: string): PolicyRegistration {
  return {
    name: "conformance:deny-all:invoke.prepare",
    timing: "invoke.prepare",
    priority: 0,
    failPolicy: "fail-closed",
    fn: () => ({ action: "deny", reason, policyId: "conformance.invoke.prepare.deny-all" }),
  };
}

function inboundDenyAll(reason: string): PolicyRegistration {
  return {
    name: "conformance:deny-all:inbound.receive",
    timing: "inbound.receive",
    priority: 0,
    failPolicy: "fail-closed",
    fn: () => ({ action: "deny", reason, policyId: "conformance.inbound.receive.deny-all" }),
  };
}

function createParentSession(): string {
  return Session.create({
    title: "parent",
    model: { providerID: model.provider, modelID: model.id },
  }).id;
}

function createChildSession(): string {
  const parentSessionId = createParentSession();
  return Session.createChild({
    parentSessionId,
    title: "worker",
    model: { providerID: model.provider, modelID: model.id },
    workerMeta: { agentName: "worker" },
  }).id;
}

function inboundEvent(): Ingress.InboundEvent {
  return {
    id: "event-no-bypass",
    surface: "tui",
    workspace: "/repo",
    mode: "direct",
    payload: "hello",
    agent: { model },
  };
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Bus.reset();
  IngressEngine.reset();
});

afterEach(() => {
  Bus.reset();
  Storage.reset();
  IngressEngine.reset();
});

describe("policy no-bypass conformance — openomni governed paths", () => {
  it("blocks subagent spawn before creating a worker session", async () => {
    const beforeSessions = Session.list().length;

    const error = await catchError(
      SubagentRuntime.spawn({
        agentName: "worker",
        title: "denied spawn",
        prompt: "should not run",
        model,
        middleware: [denyAll("subagent spawn denied by conformance policy")],
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("subagent spawn denied by conformance policy");
    expect(Session.list()).toHaveLength(beforeSessions);
  });

  it("blocks subagent send before appending a child-session message", async () => {
    const childSessionId = createChildSession();

    const error = await catchError(
      SubagentRuntime.send({
        sessionId: childSessionId,
        prompt: "should not append",
        model,
        middleware: [denyAll("subagent send denied by conformance policy")],
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("subagent send denied by conformance policy");
    expect(Session.getMessages(childSessionId)).toHaveLength(0);
  });

  it("blocks background launch before spawning a background subagent", async () => {
    const spawnSpy = spyOn(SubagentRuntime, "spawnBackground").mockResolvedValue({
      sessionId: "should-not-spawn",
      runId: "should-not-run",
    });
    const manager = BackgroundManager.create({ maxDepth: 0 });

    const task = await manager.launch({
      agentName: "worker",
      prompt: "should not run",
      model,
      parentSessionId: createParentSession(),
      depth: 1,
    });

    expect(task.status).toBe("failed");
    expect(task.error).toContain("max depth (0) exceeded");
    expect(spawnSpy).toHaveBeenCalledTimes(0);
    manager.dispose();
    spawnSpy.mockRestore();
  });

  it("blocks ingress receive before dispatching to the coordinator", async () => {
    let dispatchCalled = false;
    IngressEngine.setCoordinator({
      async dispatch(_sessionId, request) {
        dispatchCalled = true;
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "succeeded" as const,
          output: "should not dispatch",
          finishReason: "stop" as const,
        };
      },
    });
    IngressEngine.registerIngressPolicy(
      inboundDenyAll("ingress receive denied by conformance policy"),
    );

    const error = await catchError(IngressEngine.ingest(inboundEvent()));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("ingress receive denied by conformance policy");
    expect(dispatchCalled).toBe(false);
  });
});
