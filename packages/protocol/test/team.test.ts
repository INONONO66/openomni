import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Team, BusEvent } from "../src/index.js";

describe("Team Protocol Types", () => {
  describe("StepState", () => {
    it("should validate valid step states", () => {
      const validStates = ["ready", "running", "succeeded", "failed", "skipped"];
      validStates.forEach((state) => {
        expect(() => Team.StepState.parse(state)).not.toThrow();
      });
    });

    it("should reject invalid step states", () => {
      expect(() => Team.StepState.parse("invalid")).toThrow();
    });
  });

  describe("RunLedgerEntry", () => {
    it("should create a valid RunLedgerEntry with required fields", () => {
      const entry = Team.RunLedgerEntry.parse({
        stepId: "step-1",
        state: "ready",
      });
      expect(entry.stepId).toBe("step-1");
      expect(entry.state).toBe("ready");
      expect(entry.attempts).toBe(0);
      expect(entry.rejectionStreak).toBe(0);
      expect(entry.totalRejections).toBe(0);
    });

    it("should create a valid RunLedgerEntry with all fields", () => {
      const now = new Date();
      const entry = Team.RunLedgerEntry.parse({
        stepId: "step-1",
        state: "succeeded",
        assignedAgent: "agent-1",
        attempts: 3,
        rejectionStreak: 1,
        totalRejections: 2,
        error: "some error",
        result: "some result",
        startedAt: now,
        completedAt: now,
      });
      expect(entry.stepId).toBe("step-1");
      expect(entry.state).toBe("succeeded");
      expect(entry.assignedAgent).toBe("agent-1");
      expect(entry.attempts).toBe(3);
      expect(entry.rejectionStreak).toBe(1);
      expect(entry.totalRejections).toBe(2);
      expect(entry.error).toBe("some error");
      expect(entry.result).toBe("some result");
      expect(entry.startedAt).toEqual(now);
      expect(entry.completedAt).toEqual(now);
    });

    it("should reject invalid state in RunLedgerEntry", () => {
      expect(() =>
        Team.RunLedgerEntry.parse({
          stepId: "step-1",
          state: "invalid",
        }),
      ).toThrow();
    });

    it("should reject negative attempts", () => {
      expect(() =>
        Team.RunLedgerEntry.parse({
          stepId: "step-1",
          state: "ready",
          attempts: -1,
        }),
      ).toThrow();
    });
  });

  describe("StallReason", () => {
    it("should validate valid stall reasons", () => {
      const validReasons = ["consecutive_rejections", "no_progress", "unsatisfiable_deps"];
      validReasons.forEach((reason) => {
        expect(() => Team.StallReason.parse(reason)).not.toThrow();
      });
    });

    it("should reject invalid stall reasons", () => {
      expect(() => Team.StallReason.parse("invalid_reason")).toThrow();
    });
  });

  describe("ReviewDecision", () => {
    it("should create a valid ReviewDecision with accept", () => {
      const decision = Team.ReviewDecision.parse({
        decision: "accept",
      });
      expect(decision.decision).toBe("accept");
      expect(decision.feedback).toBeUndefined();
    });

    it("should create a valid ReviewDecision with reject and feedback", () => {
      const decision = Team.ReviewDecision.parse({
        decision: "reject",
        feedback: "needs improvement",
      });
      expect(decision.decision).toBe("reject");
      expect(decision.feedback).toBe("needs improvement");
    });

    it("should reject invalid decision", () => {
      expect(() =>
        Team.ReviewDecision.parse({
          decision: "invalid",
        }),
      ).toThrow();
    });
  });

  describe("Team Events", () => {
    it("should have plan.created event", () => {
      expect(Team.Events.PlanCreated).toBeDefined();
      expect(Team.Events.PlanCreated.name).toBe("plan.created");
    });

    it("should have step.assigned event", () => {
      expect(Team.Events.StepAssigned).toBeDefined();
      expect(Team.Events.StepAssigned.name).toBe("step.assigned");
    });

    it("should have step.started event", () => {
      expect(Team.Events.StepStarted).toBeDefined();
      expect(Team.Events.StepStarted.name).toBe("step.started");
    });

    it("should have step.completed event", () => {
      expect(Team.Events.StepCompleted).toBeDefined();
      expect(Team.Events.StepCompleted.name).toBe("step.completed");
    });

    it("should have step.failed event", () => {
      expect(Team.Events.StepFailed).toBeDefined();
      expect(Team.Events.StepFailed.name).toBe("step.failed");
    });

    it("should have review.decision event", () => {
      expect(Team.Events.ReviewDecision).toBeDefined();
      expect(Team.Events.ReviewDecision.name).toBe("review.decision");
    });

    it("should have step.handoff event", () => {
      expect(Team.Events.StepHandoff).toBeDefined();
      expect(Team.Events.StepHandoff.name).toBe("step.handoff");
    });

    it("should have stall.detected event", () => {
      expect(Team.Events.StallDetected).toBeDefined();
      expect(Team.Events.StallDetected.name).toBe("stall.detected");
    });

    it("should have replan.requested event", () => {
      expect(Team.Events.ReplanRequested).toBeDefined();
      expect(Team.Events.ReplanRequested.name).toBe("replan.requested");
    });

    it("should have execution.complete event", () => {
      expect(Team.Events.ExecutionComplete).toBeDefined();
      expect(Team.Events.ExecutionComplete.name).toBe("execution.complete");
    });

    it("should validate plan.created event payload", () => {
      const eventDescriptor = Team.Events.PlanCreated;
      const payload = {
        traceId: "trace-1",
        time: Date.now(),
        payload: {
          planId: "plan-1",
          goal: "test goal",
          stepCount: 5,
        },
      };
      expect(() => eventDescriptor.schema.parse(payload)).not.toThrow();
    });

    it("should validate step.assigned event payload", () => {
      const eventDescriptor = Team.Events.StepAssigned;
      const payload = {
        traceId: "trace-1",
        time: Date.now(),
        payload: {
          planId: "plan-1",
          stepId: "step-1",
          agentId: "agent-1",
        },
      };
      expect(() => eventDescriptor.schema.parse(payload)).not.toThrow();
    });

    it("should validate step.started event payload", () => {
      const eventDescriptor = Team.Events.StepStarted;
      const payload = {
        traceId: "trace-1",
        time: Date.now(),
        payload: {
          planId: "plan-1",
          stepId: "step-1",
          agentId: "agent-1",
          attempt: 1,
        },
      };
      expect(() => eventDescriptor.schema.parse(payload)).not.toThrow();
    });

    it("should validate step.completed event payload", () => {
      const eventDescriptor = Team.Events.StepCompleted;
      const payload = {
        traceId: "trace-1",
        time: Date.now(),
        payload: {
          planId: "plan-1",
          stepId: "step-1",
          result: "step result",
        },
      };
      expect(() => eventDescriptor.schema.parse(payload)).not.toThrow();
    });

    it("should validate step.failed event payload", () => {
      const eventDescriptor = Team.Events.StepFailed;
      const payload = {
        traceId: "trace-1",
        time: Date.now(),
        payload: {
          planId: "plan-1",
          stepId: "step-1",
          error: "step error",
        },
      };
      expect(() => eventDescriptor.schema.parse(payload)).not.toThrow();
    });

    it("should validate review.decision event payload", () => {
      const eventDescriptor = Team.Events.ReviewDecision;
      const payload = {
        traceId: "trace-1",
        time: Date.now(),
        payload: {
          planId: "plan-1",
          stepId: "step-1",
          decision: "accept",
          feedback: "looks good",
        },
      };
      expect(() => eventDescriptor.schema.parse(payload)).not.toThrow();
    });

    it("should validate step.handoff event payload", () => {
      const eventDescriptor = Team.Events.StepHandoff;
      const payload = {
        traceId: "trace-1",
        time: Date.now(),
        payload: {
          planId: "plan-1",
          stepId: "step-1",
          from: "agent-1",
          to: "agent-2",
          handoffDocument: "handoff info",
        },
      };
      expect(() => eventDescriptor.schema.parse(payload)).not.toThrow();
    });

    it("should validate stall.detected event payload", () => {
      const eventDescriptor = Team.Events.StallDetected;
      const payload = {
        traceId: "trace-1",
        time: Date.now(),
        payload: {
          planId: "plan-1",
          reason: "consecutive_rejections",
          details: "too many rejections",
        },
      };
      expect(() => eventDescriptor.schema.parse(payload)).not.toThrow();
    });

    it("should validate replan.requested event payload", () => {
      const eventDescriptor = Team.Events.ReplanRequested;
      const payload = {
        traceId: "trace-1",
        time: Date.now(),
        payload: {
          planId: "plan-1",
          reason: "stall detected",
        },
      };
      expect(() => eventDescriptor.schema.parse(payload)).not.toThrow();
    });

    it("should validate execution.complete event payload", () => {
      const eventDescriptor = Team.Events.ExecutionComplete;
      const payload = {
        traceId: "trace-1",
        time: Date.now(),
        payload: {
          planId: "plan-1",
          status: "completed",
          completedSteps: 5,
          failedSteps: 0,
          skippedSteps: 0,
        },
      };
      expect(() => eventDescriptor.schema.parse(payload)).not.toThrow();
    });
  });
});
