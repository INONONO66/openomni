import { describe, it, expect, beforeEach } from "bun:test";
import { Router, RouterRule } from "../../src/loop/router";
import { EventEnvelope } from "../../src/loop/envelope";

describe("Router", () => {
  beforeEach(() => {
    Router.clear();
  });

  it("register adds rule to registry", () => {
    const rule: RouterRule = {
      eventName: "user.created",
      taskId: "task-1",
      priority: 1,
    };

    Router.register(rule);

    // Verify by routing an event with that name
    const envelope: EventEnvelope = {
      id: "event-1",
      name: "user.created",
      payload: {},
      timestamp: new Date().toISOString(),
      traceId: "trace-1",
      source: "test",
    };

    const result = Router.route(envelope);
    expect(result).toContain("task-1");
  });

  it("route returns matching taskId for event name", () => {
    const rule: RouterRule = {
      eventName: "order.placed",
      taskId: "process-order",
      priority: 1,
    };

    Router.register(rule);

    const envelope: EventEnvelope = {
      id: "event-2",
      name: "order.placed",
      payload: { orderId: "123" },
      timestamp: new Date().toISOString(),
      traceId: "trace-2",
      source: "test",
    };

    const result = Router.route(envelope);
    expect(result).toEqual(["process-order"]);
  });

  it("route returns empty array when no match", () => {
    const rule: RouterRule = {
      eventName: "user.created",
      taskId: "task-1",
      priority: 1,
    };

    Router.register(rule);

    const envelope: EventEnvelope = {
      id: "event-3",
      name: "user.deleted",
      payload: {},
      timestamp: new Date().toISOString(),
      traceId: "trace-3",
      source: "test",
    };

    const result = Router.route(envelope);
    expect(result).toEqual([]);
  });

  it("route returns multiple taskIds for fan-out (same event, multiple tasks)", () => {
    const rule1: RouterRule = {
      eventName: "payment.completed",
      taskId: "send-receipt",
      priority: 1,
    };

    const rule2: RouterRule = {
      eventName: "payment.completed",
      taskId: "update-inventory",
      priority: 2,
    };

    const rule3: RouterRule = {
      eventName: "payment.completed",
      taskId: "notify-warehouse",
      priority: 3,
    };

    Router.register(rule1);
    Router.register(rule2);
    Router.register(rule3);

    const envelope: EventEnvelope = {
      id: "event-4",
      name: "payment.completed",
      payload: { amount: 100 },
      timestamp: new Date().toISOString(),
      traceId: "trace-4",
      source: "test",
    };

    const result = Router.route(envelope);
    expect(result).toEqual([
      "send-receipt",
      "update-inventory",
      "notify-warehouse",
    ]);
  });

  it("route sorts by priority (lower number = higher priority comes first)", () => {
    const rule1: RouterRule = {
      eventName: "notification.sent",
      taskId: "task-priority-3",
      priority: 3,
    };

    const rule2: RouterRule = {
      eventName: "notification.sent",
      taskId: "task-priority-1",
      priority: 1,
    };

    const rule3: RouterRule = {
      eventName: "notification.sent",
      taskId: "task-priority-2",
      priority: 2,
    };

    Router.register(rule1);
    Router.register(rule2);
    Router.register(rule3);

    const envelope: EventEnvelope = {
      id: "event-5",
      name: "notification.sent",
      payload: {},
      timestamp: new Date().toISOString(),
      traceId: "trace-5",
      source: "test",
    };

    const result = Router.route(envelope);
    expect(result).toEqual([
      "task-priority-1",
      "task-priority-2",
      "task-priority-3",
    ]);
  });

  it("unregister removes specific rule", () => {
    const rule1: RouterRule = {
      eventName: "data.synced",
      taskId: "sync-task-1",
      priority: 1,
    };

    const rule2: RouterRule = {
      eventName: "data.synced",
      taskId: "sync-task-2",
      priority: 2,
    };

    Router.register(rule1);
    Router.register(rule2);

    // Verify both are registered
    const envelope: EventEnvelope = {
      id: "event-6",
      name: "data.synced",
      payload: {},
      timestamp: new Date().toISOString(),
      traceId: "trace-6",
      source: "test",
    };

    let result = Router.route(envelope);
    expect(result).toEqual(["sync-task-1", "sync-task-2"]);

    // Unregister one rule
    Router.unregister("data.synced", "sync-task-1");

    result = Router.route(envelope);
    expect(result).toEqual(["sync-task-2"]);
  });

  it("clear removes all rules", () => {
    const rule1: RouterRule = {
      eventName: "event.a",
      taskId: "task-a",
      priority: 1,
    };

    const rule2: RouterRule = {
      eventName: "event.b",
      taskId: "task-b",
      priority: 1,
    };

    Router.register(rule1);
    Router.register(rule2);

    // Verify rules are registered
    const envelope1: EventEnvelope = {
      id: "event-7a",
      name: "event.a",
      payload: {},
      timestamp: new Date().toISOString(),
      traceId: "trace-7a",
      source: "test",
    };

    const envelope2: EventEnvelope = {
      id: "event-7b",
      name: "event.b",
      payload: {},
      timestamp: new Date().toISOString(),
      traceId: "trace-7b",
      source: "test",
    };

    expect(Router.route(envelope1)).toEqual(["task-a"]);
    expect(Router.route(envelope2)).toEqual(["task-b"]);

    // Clear all rules
    Router.clear();

    // Verify all rules are removed
    expect(Router.route(envelope1)).toEqual([]);
    expect(Router.route(envelope2)).toEqual([]);
  });

  it("route works after multiple register/unregister operations", () => {
    const rule1: RouterRule = {
      eventName: "workflow.started",
      taskId: "init-task",
      priority: 1,
    };

    const rule2: RouterRule = {
      eventName: "workflow.started",
      taskId: "validate-task",
      priority: 2,
    };

    const rule3: RouterRule = {
      eventName: "workflow.started",
      taskId: "execute-task",
      priority: 3,
    };

    // Register all rules
    Router.register(rule1);
    Router.register(rule2);
    Router.register(rule3);

    const envelope: EventEnvelope = {
      id: "event-8",
      name: "workflow.started",
      payload: {},
      timestamp: new Date().toISOString(),
      traceId: "trace-8",
      source: "test",
    };

    let result = Router.route(envelope);
    expect(result).toEqual(["init-task", "validate-task", "execute-task"]);

    // Unregister middle priority task
    Router.unregister("workflow.started", "validate-task");

    result = Router.route(envelope);
    expect(result).toEqual(["init-task", "execute-task"]);

    // Register a new rule with higher priority
    const rule4: RouterRule = {
      eventName: "workflow.started",
      taskId: "pre-init-task",
      priority: 0,
    };

    Router.register(rule4);

    result = Router.route(envelope);
    expect(result).toEqual(["pre-init-task", "init-task", "execute-task"]);

    // Unregister another rule
    Router.unregister("workflow.started", "execute-task");

    result = Router.route(envelope);
    expect(result).toEqual(["pre-init-task", "init-task"]);
  });
});
