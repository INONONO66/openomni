import { z } from "zod";
import { Tool } from "../tool/index.js";

const baseEvent = {
  actionId: z.string(),
  parentActionId: z.string().optional(),
  visibility: z.enum(["internal", "llm_reason", "user_audit"]),
  timestamp: z.string(),
  sequence: z.number(),
};

const LlmResponse = z.object({
  type: z.literal("llm_response"),
  turnIndex: z.number(),
  text: z.string(),
  toolCalls: Tool.Call.array(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
  }),
  ...baseEvent,
});

const ToolStarted = z.object({
  type: z.literal("tool_started"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  ...baseEvent,
});

const ToolCompleted = z.object({
  type: z.literal("tool_completed"),
  toolCallId: z.string(),
  result: Tool.Result,
  ...baseEvent,
});

const StepCompleted = z.object({
  type: z.literal("step_completed"),
  stepId: z.string(),
  output: z.string(),
  ...baseEvent,
});

const StepFailed = z.object({
  type: z.literal("step_failed"),
  stepId: z.string(),
  error: z.string(),
  ...baseEvent,
});

const SessionSuspended = z.object({
  type: z.literal("session_suspended"),
  reason: z.string(),
  ...baseEvent,
});

const MirroredBusEvent = z.object({
  type: z.literal("bus_event"),
  name: z.string(),
  payload: z.unknown(),
  ...baseEvent,
});

const VerdictAction = z.enum(["continue", "skip", "abort", "retry", "transform", "inject"]);

const PolicyEvaluated = z.object({
  type: z.literal("policy_evaluated"),
  policyId: z.string(),
  actor: z.record(z.string(), z.unknown()),
  action: z.string(),
  resource: z.string(),
  verdict: VerdictAction,
  reason: z.string(),
  ...baseEvent,
});

const ActionBlocked = z.object({
  type: z.literal("action_blocked"),
  policyId: z.string(),
  actor: z.record(z.string(), z.unknown()),
  action: z.string(),
  resource: z.string(),
  verdict: VerdictAction,
  reason: z.string(),
  ...baseEvent,
});

const ActionRewritten = z.object({
  type: z.literal("action_rewritten"),
  policyId: z.string(),
  actor: z.record(z.string(), z.unknown()),
  action: z.string(),
  resource: z.string(),
  verdict: VerdictAction,
  reason: z.string(),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  ...baseEvent,
});

const ActionApproved = z.object({
  type: z.literal("action_approved"),
  policyId: z.string(),
  actor: z.record(z.string(), z.unknown()),
  action: z.string(),
  resource: z.string(),
  verdict: VerdictAction,
  reason: z.string(),
  ...baseEvent,
});

export namespace ExecutionEvent {
  export const Schema = z.discriminatedUnion("type", [
    LlmResponse,
    ToolStarted,
    ToolCompleted,
    StepCompleted,
    StepFailed,
    SessionSuspended,
    MirroredBusEvent,
    PolicyEvaluated,
    ActionBlocked,
    ActionRewritten,
    ActionApproved,
  ]);

  export type LlmResponse = z.infer<typeof LlmResponse>;
  export type ToolStarted = z.infer<typeof ToolStarted>;
  export type ToolCompleted = z.infer<typeof ToolCompleted>;
  export type StepCompleted = z.infer<typeof StepCompleted>;
  export type StepFailed = z.infer<typeof StepFailed>;
  export type SessionSuspended = z.infer<typeof SessionSuspended>;
  export type MirroredBusEvent = z.infer<typeof MirroredBusEvent>;
  export type PolicyEvaluated = z.infer<typeof PolicyEvaluated>;
  export type ActionBlocked = z.infer<typeof ActionBlocked>;
  export type ActionRewritten = z.infer<typeof ActionRewritten>;
  export type ActionApproved = z.infer<typeof ActionApproved>;
}

// declaration merging: `ExecutionEvent` is both a namespace and a type
export type ExecutionEvent = z.infer<typeof ExecutionEvent.Schema>;
