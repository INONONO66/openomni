import { describe, it, expect, beforeEach } from "bun:test";
import {
  DefaultRunExecutor,
  type RunExecutor,
} from "../../src/ingress/run-executor";
import { Session, SurfaceKey } from "@openomni/session";
import { TaskManager } from "../../src/task/manager";
import { TaskStorage } from "../../src/task/storage";
import type { RunRequest } from "../../src/ingress/interfaces";
import { randomUUID } from "crypto";

function makeRunRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  const now = new Date().toISOString();
  const session =
    overrides.session ??
    Session.create({
      title: "test-session",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    });

  const envelope = overrides.envelope ?? {
    eventId: randomUUID(),
    name: "input.message",
    source: { type: "test", id: "test:source" },
    receivedAt: now,
    occurredAt: now,
    payload: "test payload",
    userId: "user1",
    workspaceId: "workspace1",
    traceId: randomUUID(),
  };

  return {
    kind: overrides.kind ?? "run_agent",
    session,
    envelope,
    taskId: overrides.taskId,
    triggerSignal: overrides.triggerSignal,
    agentConfig: overrides.agentConfig,
    notificationRequest: overrides.notificationRequest,
  };
}

describe("DefaultRunExecutor", () => {
  beforeEach(() => {
    Session.storage.clear();
    SurfaceKey.clear();
    const store = TaskStorage.getAdapter();
    store.task.list().forEach((t) => store.task.remove(t.id));
  });

  describe("trigger_task", () => {
    it("triggers existing task and returns success", async () => {
      const task = TaskManager.create({
        title: "Test task",
        owner: { type: "user", id: "u1" },
        triggers: [{ id: "t1", type: "manual" }],
      });

      const executor = new DefaultRunExecutor();
      const request = makeRunRequest({
        kind: "trigger_task",
        taskId: task.id,
        triggerSignal: {
          triggerId: "t1",
          type: "manual",
          occurredAt: Date.now(),
        },
      });

      const result = await executor.execute(request);

      expect(result.success).toBe(true);
      expect(result.runId).toBeDefined();
      expect(result.summary).toContain(task.id);
      expect(result.sessionId).toBe(request.session.id);
    });

    it("returns error for missing taskId", async () => {
      const executor = new DefaultRunExecutor();
      const request = makeRunRequest({
        kind: "trigger_task",
        taskId: undefined,
        triggerSignal: {
          triggerId: "t1",
          type: "manual",
          occurredAt: Date.now(),
        },
      });

      const result = await executor.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain("requires taskId and triggerSignal");
    });

    it("returns error for nonexistent task", async () => {
      const executor = new DefaultRunExecutor();
      const request = makeRunRequest({
        kind: "trigger_task",
        taskId: "nonexistent-task-id",
        triggerSignal: {
          triggerId: "t1",
          type: "manual",
          occurredAt: Date.now(),
        },
      });

      const result = await executor.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not_found");
    });
  });

  describe("run_agent", () => {
    it("routes through ConversationSupervisor and returns result", async () => {
      const executor = new DefaultRunExecutor();
      const request = makeRunRequest({ kind: "run_agent" });

      const result = await executor.execute(request);

      // ConversationSupervisor.run() is a stub — returns error type
      expect(result.success).toBe(false);
      expect(result.runId).toBeDefined();
      expect(result.error).toContain("ConversationSupervisor");
      expect(result.sessionId).toBe(request.session.id);
    });

    it("rejects direct ExecutionSupervisor bypass attempts", async () => {
      const executor = new DefaultRunExecutor();
      const request = makeRunRequest({
        kind: "run_agent",
        agentConfig: { agentType: "execution_direct" },
      });

      const result = await executor.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain("ConversationSupervisor");
      expect(result.error).toContain("D9");
    });

    it("uses envelope.name in task title", async () => {
      const executor = new DefaultRunExecutor();
      const now = new Date().toISOString();
      const request = makeRunRequest({
        kind: "run_agent",
        envelope: {
          eventId: randomUUID(),
          name: "custom.event.name",
          source: { type: "test", id: "test:source" },
          receivedAt: now,
          occurredAt: now,
          payload: "test",
          userId: "user1",
          workspaceId: "workspace1",
          traceId: randomUUID(),
        },
      });

      await executor.execute(request);

      const store = TaskStorage.getAdapter();
      const tasks = store.task.list();
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.title).toContain("custom.event.name");
    });

    it("sets owner to user when userId present", async () => {
      const executor = new DefaultRunExecutor();
      const now = new Date().toISOString();
      const request = makeRunRequest({
        kind: "run_agent",
        envelope: {
          eventId: randomUUID(),
          name: "test.event",
          source: { type: "test", id: "test:source" },
          receivedAt: now,
          occurredAt: now,
          payload: "test",
          userId: "user123",
          workspaceId: "workspace1",
          traceId: randomUUID(),
        },
      });

      await executor.execute(request);

      const store = TaskStorage.getAdapter();
      const tasks = store.task.list();
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.owner.type).toBe("user");
      expect(tasks[0]!.owner.id).toBe("user123");
    });

    it("sets owner to agent when userId absent", async () => {
      const executor = new DefaultRunExecutor();
      const now = new Date().toISOString();
      const request = makeRunRequest({
        kind: "run_agent",
        envelope: {
          eventId: randomUUID(),
          name: "test.event",
          source: { type: "test", id: "test:source" },
          receivedAt: now,
          occurredAt: now,
          payload: "test",
          userId: undefined,
          workspaceId: "workspace1",
          traceId: randomUUID(),
        },
      });

      await executor.execute(request);

      const store = TaskStorage.getAdapter();
      const tasks = store.task.list();
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.owner.type).toBe("agent");
      expect(tasks[0]!.owner.id).toBe("system");
    });
  });

  describe("notify_only", () => {
    it("returns success with noop adapter", async () => {
      const executor = new DefaultRunExecutor();
      const request = makeRunRequest({
        kind: "notify_only",
        notificationRequest: {
          type: "test",
          severity: "info",
          title: "Test Notification",
          body: "This is a test",
        },
      });

      const result = await executor.execute(request);

      expect(result.success).toBe(true);
      expect(result.summary).toContain("Notification delivered");
    });

    it("returns error for missing notificationRequest", async () => {
      const executor = new DefaultRunExecutor();
      const request = makeRunRequest({
        kind: "notify_only",
        notificationRequest: undefined,
      });

      const result = await executor.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain("requires notificationRequest");
    });

    it("uses custom notification adapter when configured", async () => {
      let notifyCalled = false;
      const customAdapter = {
        name: "custom",
        async notify() {
          notifyCalled = true;
          return { delivered: true, destination: "custom-destination" };
        },
      };

      const executor = new DefaultRunExecutor({ notification: customAdapter });
      const request = makeRunRequest({
        kind: "notify_only",
        notificationRequest: {
          type: "test",
          severity: "info",
          title: "Test",
          body: "Body",
        },
      });

      const result = await executor.execute(request);

      expect(notifyCalled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.summary).toContain("custom-destination");
    });
  });

  describe("custom executor", () => {
    it("allows custom executor implementation", async () => {
      const customExecutor: RunExecutor = {
        async execute(request) {
          return {
            success: true,
            summary: "Custom execution",
            sessionId: request.session.id,
            request,
          };
        },
      };

      const request = makeRunRequest({ kind: "run_agent" });
      const result = await customExecutor.execute(request);

      expect(result.success).toBe(true);
      expect(result.summary).toBe("Custom execution");
    });
  });

  describe("unknown kind", () => {
    it("returns error for unknown request kind", async () => {
      const executor = new DefaultRunExecutor();
      const request = makeRunRequest({
        kind: "unknown_kind" as any,
      });

      const result = await executor.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown run request kind");
    });
  });
});
