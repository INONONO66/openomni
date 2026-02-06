import { describe, it, expect, beforeEach } from "bun:test";
import { Router, RouterRule } from "../../src/loop/router";
import { EventEnvelope } from "../../src/loop/envelope";

function makeEnvelope(name: string): EventEnvelope {
  return {
    eventId: "event-1",
    name,
    source: { type: "test" },
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    traceId: "trace-1",
    payload: {},
  };
}

describe("Router", () => {
  beforeEach(() => {
    Router.clear();
  });

  it("returns ignore decision when no rules match", () => {
    const decision = Router.route(makeEnvelope("user.created"));
    expect(decision.action).toBe("ignore");
    expect(decision.targets).toEqual([]);
  });

  it("routes trigger_task with task target", () => {
    const rule: RouterRule = {
      id: "rule-1",
      match: { name: "order.placed" },
      action: "trigger_task",
      target: { taskId: "process-order" },
    };

    Router.register(rule);

    const decision = Router.route(makeEnvelope("order.placed"));
    expect(decision.ruleId).toBe("rule-1");
    expect(decision.action).toBe("trigger_task");
    expect(decision.targets).toEqual(["process-order"]);
  });

  it("supports fanout targets", () => {
    const rule: RouterRule = {
      id: "rule-fanout",
      match: { name: "payment.completed" },
      action: "trigger_task",
      target: { fanout: ["task-a", "task-b", "task-c"] },
    };

    Router.register(rule);

    const decision = Router.route(makeEnvelope("payment.completed"));
    expect(decision.targets).toEqual(["task-a", "task-b", "task-c"]);
  });

  it("uses first matching rule", () => {
    Router.register({
      id: "rule-first",
      match: { name: "workflow.started" },
      action: "trigger_task",
      target: { taskId: "task-first" },
    });
    Router.register({
      id: "rule-second",
      match: { name: "workflow.started" },
      action: "trigger_task",
      target: { taskId: "task-second" },
    });

    const decision = Router.route(makeEnvelope("workflow.started"));
    expect(decision.ruleId).toBe("rule-first");
    expect(decision.targets).toEqual(["task-first"]);
  });

  it("routeTargets returns compatibility target array", () => {
    Router.register({
      id: "compat-1",
      match: { name: "compat.event" },
      action: "trigger_task",
      target: { taskId: "compat-task" },
    });

    const targets = Router.routeTargets(makeEnvelope("compat.event"));
    expect(targets).toEqual(["compat-task"]);
  });
});
