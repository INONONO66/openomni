import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  ChatAgent,
  type AgentResult,
  type ChatAgentInput,
  type PolicyRegistration,
} from "@openomni/agent";
import { Subagent } from "@openomni/protocol";
import { Bus, Session, Storage, WorkerRun } from "@openomni/session";
import { SubagentRuntime } from "../../src/subagent/runtime";

const runCalls: ChatAgentInput[] = [];
const runResults: AgentResult[] = [];

let createSpy: ReturnType<typeof spyOn>;

function queueResult(text: string): void {
  runResults.push({
    text,
    steps: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    finishReason: "stop",
  });
}

function createParentSession(): string {
  return Session.create({
    title: "parent",
    model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
  }).id;
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Bus.reset();
  runCalls.length = 0;
  runResults.length = 0;
  createSpy = spyOn(ChatAgent, "create").mockImplementation(() => {
    return {
      run: async (input: ChatAgentInput) => {
        runCalls.push(input);

        const next = runResults.shift();
        if (!next) {
          throw new Error("No mocked agent result queued");
        }

        return next;
      },
    } as unknown as ReturnType<typeof ChatAgent.create>;
  });
});

afterEach(() => {
  createSpy.mockRestore();
  Bus.reset();
  Storage.reset();
});

describe("SubagentRuntime", () => {
  it("spawn creates a child session linked to the parent", async () => {
    const parentSessionId = createParentSession();
    queueResult("first output");

    const result = await SubagentRuntime.spawn({
      parentSessionId,
      agentName: "worker",
      title: "child task",
      prompt: "solve this",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    const childSession = Session.get(result.sessionId);
    expect(childSession).toBeDefined();
    expect(childSession?.parentSessionId).toBe(parentSessionId);
    expect(childSession?.spawnDepth).toBe(1);
  });

  it("spawn returns output text", async () => {
    queueResult("spawned answer");

    const result = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "child task",
      prompt: "solve this",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result.output).toBe("spawned answer");
    expect(result.finishReason).toBe("stop");
  });

  it("spawn emits worker lifecycle events once through WorkerRun.updateStatus", async () => {
    queueResult("spawned answer");
    const started: Array<{ payload: { runId: string; sessionId: string; title: string } }> = [];
    const completed: Array<{ payload: { runId: string; sessionId: string; status: string } }> = [];
    const unsubscribeStarted = Bus.subscribe(Subagent.Events.WorkerRunStarted, (event) => {
      started.push(event);
    });
    const unsubscribeCompleted = Bus.subscribe(Subagent.Events.WorkerRunCompleted, (event) => {
      completed.push(event);
    });

    const result = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "child task",
      prompt: "solve this",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribeStarted();
    unsubscribeCompleted();

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0].payload).toEqual({
      sessionId: result.sessionId,
      runId: result.runId,
      title: "child task",
    });
    expect(completed[0].payload).toEqual({
      sessionId: result.sessionId,
      runId: result.runId,
      status: "succeeded",
    });
  });

  it("send reuses the full transcript for the same session", async () => {
    queueResult("first answer");
    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "child task",
      prompt: "first prompt",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    queueResult("second answer");
    const sent = await SubagentRuntime.send({
      sessionId: spawned.sessionId,
      prompt: "second prompt",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(sent.output).toBe("second answer");
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1]?.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
    ]);
  });

  it("wait returns the persisted run status and output", async () => {
    queueResult("done");
    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "child task",
      prompt: "solve this",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    const waited = await SubagentRuntime.wait({
      sessionId: spawned.sessionId,
      runId: spawned.runId,
    });

    expect(waited).toEqual({
      status: "succeeded",
      output: "done",
    });
  });

  it("spawn works without a parent session", async () => {
    queueResult("standalone answer");

    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "standalone task",
      prompt: "do work",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    const session = Session.get(spawned.sessionId);
    expect(session).toBeDefined();
    expect(session?.parentSessionId).toBeUndefined();
    expect(session?.spawnDepth).toBe(0);
  });

  describe("resume", () => {
    const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

    it("creates a new run on an idle session and returns output", async () => {
      queueResult("first");
      const spawned = await SubagentRuntime.spawn({
        agentName: "worker",
        title: "task",
        prompt: "do work",
        model,
      });

      queueResult("resumed output");
      const result = await SubagentRuntime.resume({
        sessionId: spawned.sessionId,
        model,
      });

      expect(result.resumed).toBe(true);
      expect(result.sessionId).toBe(spawned.sessionId);
      expect(result.runId).toBeDefined();
      expect(result.output).toBe("resumed output");
      expect(result.finishReason).toBe("stop");
    });

    it("throws when session has an active run", async () => {
      const session = Session.create({
        title: "busy",
        model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
      });

      const runId = crypto.randomUUID();
      await WorkerRun.create(session.id, {
        runId,
        title: "active",
        prompt: "working",
      });
      await WorkerRun.updateStatus(session.id, runId, "starting");
      await WorkerRun.updateStatus(session.id, runId, "running");

      const error = await SubagentRuntime.resume({ sessionId: session.id, model }).catch(
        (err) => err,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Session already has an active run");
    });

    it("returns resumed false for non-existent session", async () => {
      const result = await SubagentRuntime.resume({
        sessionId: "nonexistent",
        model,
      });

      expect(result.resumed).toBe(false);
      expect(result.runId).toBeUndefined();
    });
  });

  describe("cancel", () => {
    it("cancels a specific run by runId", async () => {
      const session = Session.create({
        title: "to-cancel",
        model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
      });

      const runId = crypto.randomUUID();
      await WorkerRun.create(session.id, {
        runId,
        title: "active",
        prompt: "working",
      });
      await WorkerRun.updateStatus(session.id, runId, "starting");
      await WorkerRun.updateStatus(session.id, runId, "running");

      await SubagentRuntime.cancel({ sessionId: session.id, runId });

      const run = await WorkerRun.get(session.id, runId);
      expect(run?.status).toBe("cancelled");
    });

    it("cancels the active run when no runId provided", async () => {
      const session = Session.create({
        title: "to-cancel",
        model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
      });

      const runId = crypto.randomUUID();
      await WorkerRun.create(session.id, {
        runId,
        title: "active",
        prompt: "working",
      });
      await WorkerRun.updateStatus(session.id, runId, "starting");
      await WorkerRun.updateStatus(session.id, runId, "running");

      await SubagentRuntime.cancel({ sessionId: session.id });

      const run = await WorkerRun.get(session.id, runId);
      expect(run?.status).toBe("cancelled");
    });

    it("is a no-op for non-existent session", async () => {
      await SubagentRuntime.cancel({ sessionId: "nonexistent" });
    });
  });

  describe("invoke.prepare policy", () => {
    const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

    it("spawn aborts when invoke.prepare policy returns abort", async () => {
      const abortPolicy: PolicyRegistration = {
        name: "test:block-delegation",
        timing: "invoke.prepare",
        priority: 0,
        fn: () => ({
          action: "abort" as const,
          reason: "delegation denied by test policy",
          policyId: "test:block",
        }),
      };

      const error = await SubagentRuntime.spawn({
        agentName: "worker",
        title: "blocked task",
        prompt: "should not run",
        model,
        middleware: [abortPolicy],
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("delegation denied by test policy");
    });

    it("spawn proceeds when invoke.prepare policy returns continue", async () => {
      queueResult("allowed output");

      const allowPolicy: PolicyRegistration = {
        name: "test:allow-delegation",
        timing: "invoke.prepare",
        priority: 0,
        fn: () => ({
          action: "continue" as const,
          policyId: "test:allow",
        }),
      };

      const result = await SubagentRuntime.spawn({
        agentName: "worker",
        title: "allowed task",
        prompt: "do work",
        model,
        middleware: [allowPolicy],
      });

      expect(result.output).toBe("allowed output");
    });

    it("spawn applies transform constraints from invoke.prepare verdict", async () => {
      queueResult("transformed output");

      const transformPolicy: PolicyRegistration = {
        name: "test:transform-delegation",
        timing: "invoke.prepare",
        priority: 0,
        fn: () => ({
          action: "transform" as const,
          input: { softTimeoutMs: 5000, hardTimeoutMs: 10000 },
          reason: "enforce timeout limits",
          policyId: "test:transform",
        }),
      };

      const config: Parameters<typeof SubagentRuntime.spawn>[0] = {
        agentName: "worker",
        title: "transformed task",
        prompt: "do work",
        model,
        middleware: [transformPolicy],
      };

      const result = await SubagentRuntime.spawn(config);
      expect(result.output).toBe("transformed output");
      expect(config.softTimeoutMs).toBe(5000);
      expect(config.hardTimeoutMs).toBe(10000);
    });

    it("invoke.prepare receives parent/child agent labels", async () => {
      queueResult("labeled output");
      const parentSessionId = createParentSession();

      let capturedLabels: unknown;
      let capturedToolInput: unknown;
      const capturePolicy: PolicyRegistration = {
        name: "test:capture-ctx",
        timing: "invoke.prepare",
        priority: 0,
        fn: (ctx) => {
          capturedLabels = ctx.labels;
          capturedToolInput = ctx.toolInput;
          return { action: "continue" as const, policyId: "test:capture" };
        },
      };

      await SubagentRuntime.spawn({
        parentSessionId,
        agentName: "child-agent",
        title: "labeled task",
        prompt: "test labels",
        model,
        middleware: [capturePolicy],
      });

      expect(capturedToolInput).toEqual({
        operation: "spawn",
        childAgent: "child-agent",
        prompt: "test labels",
        parentSessionId,
      });
      expect(capturedLabels).toEqual([
        { value: "actor.child:child-agent", source: "system" },
        { value: `actor.parent:${parentSessionId}`, source: "system" },
      ]);
    });

    it("send aborts when invoke.prepare policy returns abort", async () => {
      queueResult("spawned");
      const spawned = await SubagentRuntime.spawn({
        agentName: "worker",
        title: "child",
        prompt: "initial",
        model,
      });

      const abortPolicy: PolicyRegistration = {
        name: "test:block-send",
        timing: "invoke.prepare",
        priority: 0,
        fn: () => ({
          action: "abort" as const,
          reason: "send delegation denied",
          policyId: "test:block-send",
        }),
      };

      const error = await SubagentRuntime.send({
        sessionId: spawned.sessionId,
        prompt: "should not run",
        model,
        middleware: [abortPolicy],
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("send delegation denied");
    });

    it("spawn without middleware proceeds normally (no invoke.prepare dispatch)", async () => {
      queueResult("no middleware output");

      const result = await SubagentRuntime.spawn({
        agentName: "worker",
        title: "no-middleware task",
        prompt: "do work",
        model,
      });

      expect(result.output).toBe("no middleware output");
    });
  });
});
