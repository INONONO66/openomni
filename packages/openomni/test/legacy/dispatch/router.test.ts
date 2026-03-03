import { describe, it, expect, beforeEach } from "bun:test";
import { Router, RouterRule, EventEnvelope } from "../../../src/legacy/dispatch";

function makeEnvelope(name: string, dedupeKey?: string): EventEnvelope {
  return {
    eventId: "event-1",
    name,
    source: { type: "test" },
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    traceId: "trace-1",
    dedupeKey,
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

  describe("Deduplication", () => {
    beforeEach(() => {
      Router.clearDedupeCache();
      Router.configureDedupeWindow(100, 10000);
    });

    it("deduplicates events with same dedupeKey within window", () => {
      const decision1 = Router.route(makeEnvelope("test.event", "key-1"));
      expect(decision1.action).toBe("ignore");
      expect(decision1.reason).toBe("No matching routing rule");

      const decision2 = Router.route(makeEnvelope("test.event", "key-1"));
      expect(decision2.action).toBe("ignore");
      expect(decision2.reason).toBe("Event deduplicated");
    });

    it("allows events with same dedupeKey after window expires", async () => {
      Router.configureDedupeWindow(50, 10000);

      const decision1 = Router.route(makeEnvelope("test.event", "key-2"));
      expect(decision1.reason).toBe("No matching routing rule");

      await new Promise((resolve) => setTimeout(resolve, 60));

      const decision2 = Router.route(makeEnvelope("test.event", "key-2"));
      expect(decision2.reason).toBe("No matching routing rule");
    });

    it("routes events without dedupeKey normally", () => {
      Router.register({
        id: "rule-1",
        match: { name: "test.event" },
        action: "trigger_task",
        target: { taskId: "task-1" },
      });

      const decision1 = Router.route(makeEnvelope("test.event"));
      expect(decision1.action).toBe("trigger_task");
      expect(decision1.targets).toEqual(["task-1"]);

      const decision2 = Router.route(makeEnvelope("test.event"));
      expect(decision2.action).toBe("trigger_task");
      expect(decision2.targets).toEqual(["task-1"]);
    });

    it("enforces maxEntries limit by evicting oldest entry", () => {
      Router.configureDedupeWindow(10000, 3);

      Router.route(makeEnvelope("test.event", "key-a"));
      Router.route(makeEnvelope("test.event", "key-b"));
      Router.route(makeEnvelope("test.event", "key-c"));
      Router.route(makeEnvelope("test.event", "key-d"));

      const decisionA = Router.route(makeEnvelope("test.event", "key-a"));
      expect(decisionA.reason).toBe("No matching routing rule");

      const decisionD = Router.route(makeEnvelope("test.event", "key-d"));
      expect(decisionD.reason).toBe("Event deduplicated");
    });

    it("clears deduplication cache", () => {
      Router.route(makeEnvelope("test.event", "key-1"));

      Router.clearDedupeCache();

      const decision = Router.route(makeEnvelope("test.event", "key-1"));
      expect(decision.reason).toBe("No matching routing rule");
    });
  });

  describe("Fallback Rule", () => {
    beforeEach(() => {
      Router.clear();
    });

    it("uses fallback rule when no rule matches", () => {
      const fallbackRule: RouterRule = {
        id: "fallback-rule",
        match: {},
        action: "trigger_task",
        target: { taskId: "fallback-task" },
      };

      Router.register(fallbackRule);
      Router.setFallbackRuleId("fallback-rule");

      const decision = Router.route(makeEnvelope("unknown.event"));
      expect(decision.ruleId).toBe("fallback-rule");
      expect(decision.action).toBe("trigger_task");
      expect(decision.targets).toEqual(["fallback-task"]);
      expect(decision.reason).toContain("fallback");
    });

    it("prefers explicit rule match over fallback", () => {
      const explicitRule: RouterRule = {
        id: "explicit-rule",
        match: { name: "known.event" },
        action: "trigger_task",
        target: { taskId: "explicit-task" },
      };

      const fallbackRule: RouterRule = {
        id: "fallback-rule",
        match: {},
        action: "trigger_task",
        target: { taskId: "fallback-task" },
      };

      Router.register(explicitRule);
      Router.register(fallbackRule);
      Router.setFallbackRuleId("fallback-rule");

      const decision = Router.route(makeEnvelope("known.event"));
      expect(decision.ruleId).toBe("explicit-rule");
      expect(decision.targets).toEqual(["explicit-task"]);
    });

    it("ignores when fallback rule ID does not exist", () => {
      Router.setFallbackRuleId("nonexistent-rule");

      const decision = Router.route(makeEnvelope("unknown.event"));
      expect(decision.action).toBe("ignore");
      expect(decision.targets).toEqual([]);
      expect(decision.reason).toBe("No matching routing rule");
    });

    it("ignores when no fallback rule is set", () => {
      const decision = Router.route(makeEnvelope("unknown.event"));
      expect(decision.action).toBe("ignore");
      expect(decision.targets).toEqual([]);
    });
  });
});
