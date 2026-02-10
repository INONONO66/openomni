import { describe, it, expect } from "bun:test";
import {
  CONTROL_EVENT_KINDS,
  TELEMETRY_EVENT_KINDS,
  EVENT_KINDS,
  classifyLane,
  isTaskBackable,
  type EventKind,
  type EventLane,
} from "../../src/ingress/event-kinds";

describe("event-kinds", () => {
  describe("EventKind constants", () => {
    it("should export CONTROL_EVENT_KINDS with 10 kinds", () => {
      const kinds = Object.values(CONTROL_EVENT_KINDS);
      expect(kinds).toHaveLength(10);
      expect(kinds).toContain("input.message");
      expect(kinds).toContain("message");
      expect(kinds).toContain("input.webhook");
      expect(kinds).toContain("schedule.fire");
      expect(kinds).toContain("scheduler.cron");
      expect(kinds).toContain("scheduler.interval");
      expect(kinds).toContain("scheduler.once");
      expect(kinds).toContain("subagent.spawned");
      expect(kinds).toContain("subagent.completed");
      expect(kinds).toContain("subagent.failed");
    });

    it("should export TELEMETRY_EVENT_KINDS with 3 kinds", () => {
      const kinds = Object.values(TELEMETRY_EVENT_KINDS);
      expect(kinds).toHaveLength(3);
      expect(kinds).toContain("run.metric");
      expect(kinds).toContain("tool.metric");
      expect(kinds).toContain("heartbeat");
    });

    it("should export EVENT_KINDS combining both control and telemetry", () => {
      const kinds = Object.values(EVENT_KINDS);
      expect(kinds).toHaveLength(13);
      expect(kinds).toContain("input.message");
      expect(kinds).toContain("run.metric");
      expect(kinds).toContain("heartbeat");
    });

    it("should have no duplicate kinds across lanes", () => {
      const controlKinds = Object.values(CONTROL_EVENT_KINDS);
      const telemetryKinds = Object.values(TELEMETRY_EVENT_KINDS);
      const intersection = controlKinds.filter((k) =>
        (telemetryKinds as string[]).includes(k as string),
      );
      expect(intersection).toHaveLength(0);
    });
  });

  describe("classifyLane()", () => {
    it("should classify input.message as control", () => {
      expect(classifyLane("input.message")).toBe("control");
    });

    it("should classify input.webhook as control", () => {
      expect(classifyLane("input.webhook")).toBe("control");
    });

    it("should classify schedule.fire as control", () => {
      expect(classifyLane("schedule.fire")).toBe("control");
    });

    it("should classify subagent.spawned as control", () => {
      expect(classifyLane("subagent.spawned")).toBe("control");
    });

    it("should classify subagent.completed as control", () => {
      expect(classifyLane("subagent.completed")).toBe("control");
    });

    it("should classify subagent.failed as control", () => {
      expect(classifyLane("subagent.failed")).toBe("control");
    });

    it("should classify run.metric as telemetry", () => {
      expect(classifyLane("run.metric")).toBe("telemetry");
    });

    it("should classify tool.metric as telemetry", () => {
      expect(classifyLane("tool.metric")).toBe("telemetry");
    });

    it("should classify heartbeat as telemetry", () => {
      expect(classifyLane("heartbeat")).toBe("telemetry");
    });

    it("should classify unknown kinds as telemetry (safe default)", () => {
      expect(classifyLane("unknown.kind")).toBe("telemetry");
      expect(classifyLane("random.event")).toBe("telemetry");
      expect(classifyLane("")).toBe("telemetry");
    });
  });

  describe("isTaskBackable()", () => {
    it("should return true for input.message", () => {
      expect(isTaskBackable("input.message")).toBe(true);
    });

    it("should return true for input.webhook", () => {
      expect(isTaskBackable("input.webhook")).toBe(true);
    });

    it("should return true for schedule.fire", () => {
      expect(isTaskBackable("schedule.fire")).toBe(true);
    });

    it("should return true for subagent.spawned", () => {
      expect(isTaskBackable("subagent.spawned")).toBe(true);
    });

    it("should return true for subagent.completed", () => {
      expect(isTaskBackable("subagent.completed")).toBe(true);
    });

    it("should return true for subagent.failed", () => {
      expect(isTaskBackable("subagent.failed")).toBe(true);
    });

    it("should return false for run.metric", () => {
      expect(isTaskBackable("run.metric")).toBe(false);
    });

    it("should return false for tool.metric", () => {
      expect(isTaskBackable("tool.metric")).toBe(false);
    });

    it("should return false for heartbeat", () => {
      expect(isTaskBackable("heartbeat")).toBe(false);
    });

    it("should return false for unknown kinds", () => {
      expect(isTaskBackable("unknown.kind")).toBe(false);
      expect(isTaskBackable("random.event")).toBe(false);
      expect(isTaskBackable("")).toBe(false);
    });
  });

  describe("type safety", () => {
    it("should allow EventKind type for valid control kinds", () => {
      const kind = CONTROL_EVENT_KINDS.INPUT_MESSAGE as EventKind;
      expect(kind).toBe("input.message");
    });

    it("should allow EventKind type for valid telemetry kinds", () => {
      const kind = TELEMETRY_EVENT_KINDS.RUN_METRIC as EventKind;
      expect(kind).toBe("run.metric");
    });

    it("should allow EventLane type for control", () => {
      const lane: EventLane = "control";
      expect(lane).toBe("control");
    });

    it("should allow EventLane type for telemetry", () => {
      const lane: EventLane = "telemetry";
      expect(lane).toBe("telemetry");
    });
  });
});
