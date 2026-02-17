import { describe, test, expect, beforeEach } from "bun:test";
import { DefaultRunPlanner } from "../../src/ingress/engine";
import type { EventEnvelope } from "../../src/dispatch/envelope";
import { Session } from "@openomni/session";
import {
  CONTROL_EVENT_KINDS,
  TELEMETRY_EVENT_KINDS,
} from "../../src/ingress/event-kinds";

describe("DefaultRunPlanner - Lane Guard", () => {
  let session: ReturnType<typeof Session.create>;

  beforeEach(() => {
    session = Session.create({
      title: "test-session",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    });
  });

  function makeEnvelope(name: string): EventEnvelope {
    const now = new Date().toISOString();
    return {
      eventId: "evt-123",
      name,
      source: { type: "webhook" },
      payload: {},
      occurredAt: now,
      receivedAt: now,
      userId: "user-1",
      workspaceId: "ws-1",
      traceId: "trace-1",
    };
  }

  describe("Telemetry lane events", () => {
    test("should return empty array for run.metric event", () => {
      const envelope = makeEnvelope(TELEMETRY_EVENT_KINDS.RUN_METRIC);
      const result = DefaultRunPlanner.plan(envelope, session);
      expect(result).toEqual([]);
    });

    test("should return empty array for tool.metric event", () => {
      const envelope = makeEnvelope(TELEMETRY_EVENT_KINDS.TOOL_METRIC);
      const result = DefaultRunPlanner.plan(envelope, session);
      expect(result).toEqual([]);
    });

    test("should return empty array for heartbeat event", () => {
      const envelope = makeEnvelope(TELEMETRY_EVENT_KINDS.HEARTBEAT);
      const result = DefaultRunPlanner.plan(envelope, session);
      expect(result).toEqual([]);
    });
  });

  describe("Control lane events", () => {
    test("should produce RunRequest for input.message event", () => {
      const envelope = makeEnvelope(CONTROL_EVENT_KINDS.INPUT_MESSAGE);
      const result = DefaultRunPlanner.plan(envelope, session);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].kind).toBe("run_agent");
    });

    test("should produce RunRequest for input.webhook event", () => {
      const envelope = makeEnvelope(CONTROL_EVENT_KINDS.INPUT_WEBHOOK);
      const result = DefaultRunPlanner.plan(envelope, session);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].kind).toBe("run_agent");
    });

    test("should produce RunRequest for schedule.fire event with taskId", () => {
      const envelope = makeEnvelope(CONTROL_EVENT_KINDS.SCHEDULE_FIRE);
      envelope.source.type = "scheduler";
      envelope.meta = { taskId: "task-123", triggerId: "trigger-1" };
      const result = DefaultRunPlanner.plan(envelope, session);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].kind).toBe("trigger_task");
    });
  });

  describe("Unknown event kinds", () => {
    test("should default to telemetry lane and return empty array", () => {
      const envelope = makeEnvelope("unknown.event.kind");
      const result = DefaultRunPlanner.plan(envelope, session);
      expect(result).toEqual([]);
    });
  });
});
