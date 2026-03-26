import { describe, it, expect } from "bun:test";
import { Dispatcher } from "../../../src/legacy/dispatch/dispatcher";
import { Task } from "../../../src/legacy/task/types";

describe("Dispatcher.evaluateCondition", () => {
  it("eq operator matches equal values", () => {
    const condition: Task.TriggerFilterCondition = {
      path: "status",
      op: "eq",
      value: "active",
    };
    expect(Dispatcher.evaluateCondition(condition, { status: "active" })).toBe(true);
    expect(Dispatcher.evaluateCondition(condition, { status: "inactive" })).toBe(false);
  });

  it("neq operator matches non-equal values", () => {
    const condition: Task.TriggerFilterCondition = {
      path: "status",
      op: "neq",
      value: "active",
    };
    expect(Dispatcher.evaluateCondition(condition, { status: "inactive" })).toBe(true);
    expect(Dispatcher.evaluateCondition(condition, { status: "active" })).toBe(false);
  });

  it("in operator checks array membership", () => {
    const condition: Task.TriggerFilterCondition = {
      path: "role",
      op: "in",
      value: ["admin", "editor"],
    };
    expect(Dispatcher.evaluateCondition(condition, { role: "admin" })).toBe(true);
    expect(Dispatcher.evaluateCondition(condition, { role: "viewer" })).toBe(false);
  });

  it("nin operator checks non-membership", () => {
    const condition: Task.TriggerFilterCondition = {
      path: "role",
      op: "nin",
      value: ["admin", "editor"],
    };
    expect(Dispatcher.evaluateCondition(condition, { role: "viewer" })).toBe(true);
    expect(Dispatcher.evaluateCondition(condition, { role: "admin" })).toBe(false);
  });

  it("exists operator checks path existence", () => {
    const existsTrue: Task.TriggerFilterCondition = {
      path: "name",
      op: "exists",
      value: true,
    };
    const existsFalse: Task.TriggerFilterCondition = {
      path: "name",
      op: "exists",
      value: false,
    };
    expect(Dispatcher.evaluateCondition(existsTrue, { name: "alice" })).toBe(true);
    expect(Dispatcher.evaluateCondition(existsTrue, { age: 30 })).toBe(false);
    expect(Dispatcher.evaluateCondition(existsFalse, { age: 30 })).toBe(true);
    expect(Dispatcher.evaluateCondition(existsFalse, { name: "alice" })).toBe(false);
  });

  it("regex operator matches patterns", () => {
    const condition: Task.TriggerFilterCondition = {
      path: "email",
      op: "regex",
      value: "^[a-z]+@example\\.com$",
    };
    expect(Dispatcher.evaluateCondition(condition, { email: "alice@example.com" })).toBe(true);
    expect(Dispatcher.evaluateCondition(condition, { email: "ALICE@example.com" })).toBe(false);
    expect(Dispatcher.evaluateCondition(condition, { email: "alice@other.com" })).toBe(false);
  });

  it("gt/gte/lt/lte operators for numeric comparison", () => {
    const payload = { score: 75 };

    const gt: Task.TriggerFilterCondition = {
      path: "score",
      op: "gt",
      value: 50,
    };
    const gte: Task.TriggerFilterCondition = {
      path: "score",
      op: "gte",
      value: 75,
    };
    const lt: Task.TriggerFilterCondition = {
      path: "score",
      op: "lt",
      value: 100,
    };
    const lte: Task.TriggerFilterCondition = {
      path: "score",
      op: "lte",
      value: 75,
    };

    expect(Dispatcher.evaluateCondition(gt, payload)).toBe(true);
    expect(Dispatcher.evaluateCondition(gte, payload)).toBe(true);
    expect(Dispatcher.evaluateCondition(lt, payload)).toBe(true);
    expect(Dispatcher.evaluateCondition(lte, payload)).toBe(true);

    const gtFail: Task.TriggerFilterCondition = {
      path: "score",
      op: "gt",
      value: 75,
    };
    const ltFail: Task.TriggerFilterCondition = {
      path: "score",
      op: "lt",
      value: 75,
    };
    expect(Dispatcher.evaluateCondition(gtFail, payload)).toBe(false);
    expect(Dispatcher.evaluateCondition(ltFail, payload)).toBe(false);
  });

  it("dot notation path resolution works correctly", () => {
    const condition: Task.TriggerFilterCondition = {
      path: "user.address.city",
      op: "eq",
      value: "Tokyo",
    };
    const payload = { user: { address: { city: "Tokyo" } } };
    expect(Dispatcher.evaluateCondition(condition, payload)).toBe(true);

    const payloadMissing = { user: { address: {} } };
    expect(Dispatcher.evaluateCondition(condition, payloadMissing)).toBe(false);
  });
});

describe("Dispatcher.evaluateFilter", () => {
  it("mode 'all' requires all conditions to pass", () => {
    const filter: Task.TriggerFilter = {
      mode: "all",
      conditions: [
        { path: "status", op: "eq", value: "active" },
        { path: "score", op: "gt", value: 50 },
      ],
    };
    expect(Dispatcher.evaluateFilter(filter, { status: "active", score: 80 })).toBe(true);
    expect(Dispatcher.evaluateFilter(filter, { status: "active", score: 30 })).toBe(false);
    expect(Dispatcher.evaluateFilter(filter, { status: "inactive", score: 80 })).toBe(false);
  });

  it("mode 'any' requires at least one condition to pass", () => {
    const filter: Task.TriggerFilter = {
      mode: "any",
      conditions: [
        { path: "status", op: "eq", value: "active" },
        { path: "score", op: "gt", value: 90 },
      ],
    };
    expect(Dispatcher.evaluateFilter(filter, { status: "active", score: 10 })).toBe(true);
    expect(Dispatcher.evaluateFilter(filter, { status: "inactive", score: 95 })).toBe(true);
    expect(Dispatcher.evaluateFilter(filter, { status: "inactive", score: 10 })).toBe(false);
  });
});
