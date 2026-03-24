import { z } from "zod";
import { Tool } from "../tool/index.js";

const baseEvent = {
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

export namespace ExecutionEvent {
  export const Schema = z.discriminatedUnion("type", [
    LlmResponse,
    ToolStarted,
    ToolCompleted,
    StepCompleted,
    StepFailed,
    SessionSuspended,
  ]);
  export type T = z.infer<typeof Schema>;

  export type LlmResponse = z.infer<typeof LlmResponse>;
  export type ToolStarted = z.infer<typeof ToolStarted>;
  export type ToolCompleted = z.infer<typeof ToolCompleted>;
  export type StepCompleted = z.infer<typeof StepCompleted>;
  export type StepFailed = z.infer<typeof StepFailed>;
  export type SessionSuspended = z.infer<typeof SessionSuspended>;
}
