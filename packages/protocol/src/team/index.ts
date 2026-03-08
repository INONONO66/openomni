import { z } from "zod";
import { BusEvent } from "../bus/index.js";

/**
 * Base event schema with correlation fields
 * All team events must include these fields for tracing and correlation
 */
const BaseEvent = z.object({
  traceId: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  time: z.number(),
});

export namespace Team {
  /**
   * Step execution state enum
   */
  export const StepState = z.enum([
    "ready",
    "running",
    "succeeded",
    "failed",
    "skipped",
  ]);
  export type StepState = z.infer<typeof StepState>;

  /**
   * RunLedgerEntry tracks the execution state of a single step
   */
  export const RunLedgerEntry = z.object({
    stepId: z.string(),
    state: StepState,
    assignedAgent: z.string().optional(),
    attempts: z.number().int().min(0).default(0),
    rejectionStreak: z.number().int().min(0).default(0),
    totalRejections: z.number().int().min(0).default(0),
    error: z.string().optional(),
    result: z.string().optional(),
    startedAt: z.date().optional(),
    completedAt: z.date().optional(),
  });
  export type RunLedgerEntry = z.infer<typeof RunLedgerEntry>;

  /**
   * Stall reason enum for execution stalls
   */
  export const StallReason = z.enum([
    "consecutive_rejections",
    "no_progress",
    "unsatisfiable_deps",
  ]);
  export type StallReason = z.infer<typeof StallReason>;

  /**
   * ReviewDecision for step review outcomes
   */
  export const ReviewDecision = z.object({
    decision: z.enum(["accept", "reject"]),
    feedback: z.string().optional(),
  });
  export type ReviewDecision = z.infer<typeof ReviewDecision>;

  /**
   * Team Events namespace
   */
  export namespace Events {
    /**
     * plan.created - Emitted when a new plan is created
     */
    export const PlanCreated = BusEvent.define(
      "plan.created",
      BaseEvent.extend({
        payload: z.object({
          planId: z.string(),
          goal: z.string(),
          stepCount: z.number().int(),
        }),
      }),
    );

    /**
     * step.assigned - Emitted when a step is assigned to an agent
     */
    export const StepAssigned = BusEvent.define(
      "step.assigned",
      BaseEvent.extend({
        payload: z.object({
          planId: z.string(),
          stepId: z.string(),
          agentId: z.string(),
        }),
      }),
    );

    /**
     * step.started - Emitted when a step execution starts
     */
    export const StepStarted = BusEvent.define(
      "step.started",
      BaseEvent.extend({
        payload: z.object({
          planId: z.string(),
          stepId: z.string(),
          agentId: z.string(),
          attempt: z.number().int().min(1),
        }),
      }),
    );

    /**
     * step.completed - Emitted when a step completes successfully
     */
    export const StepCompleted = BusEvent.define(
      "step.completed",
      BaseEvent.extend({
        payload: z.object({
          planId: z.string(),
          stepId: z.string(),
          result: z.string(),
        }),
      }),
    );

    /**
     * step.failed - Emitted when a step fails
     */
    export const StepFailed = BusEvent.define(
      "step.failed",
      BaseEvent.extend({
        payload: z.object({
          planId: z.string(),
          stepId: z.string(),
          error: z.string(),
        }),
      }),
    );

    /**
     * review.decision - Emitted when a step review decision is made
     */
    export const ReviewDecision = BusEvent.define(
      "review.decision",
      BaseEvent.extend({
        payload: z.object({
          planId: z.string(),
          stepId: z.string(),
          decision: z.enum(["accept", "reject"]),
          feedback: z.string().optional(),
        }),
      }),
    );

    /**
     * step.handoff - Emitted when a step is handed off between agents
     */
    export const StepHandoff = BusEvent.define(
      "step.handoff",
      BaseEvent.extend({
        payload: z.object({
          planId: z.string(),
          stepId: z.string(),
          from: z.string(),
          to: z.string(),
          handoffDocument: z.string(),
        }),
      }),
    );

    /**
     * stall.detected - Emitted when execution stall is detected
     */
    export const StallDetected = BusEvent.define(
      "stall.detected",
      BaseEvent.extend({
        payload: z.object({
          planId: z.string(),
          reason: StallReason,
          details: z.string(),
        }),
      }),
    );

    /**
     * replan.requested - Emitted when replanning is requested
     */
    export const ReplanRequested = BusEvent.define(
      "replan.requested",
      BaseEvent.extend({
        payload: z.object({
          planId: z.string(),
          reason: z.string(),
        }),
      }),
    );

    /**
     * execution.complete - Emitted when execution completes
     */
    export const ExecutionComplete = BusEvent.define(
      "execution.complete",
      BaseEvent.extend({
        payload: z.object({
          planId: z.string(),
          status: z.string(),
          completedSteps: z.number().int().min(0),
          failedSteps: z.number().int().min(0),
          skippedSteps: z.number().int().min(0),
        }),
      }),
    );
  }
}
