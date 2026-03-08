import { z } from "zod";
import { Tool } from "../tool/index.js";
import { PlanResult } from "../plan/index.js";

// AgentDef — agent configuration passed in by callers (CLI/CUI layer)
export const AgentDefSchema = z.object({
  model: z.object({ provider: z.string(), id: z.string() }),
  systemPrompt: z.string().optional(),
  tools: z.array(Tool.Spec).optional(),
  budget: z.object({ maxTurns: z.number().optional() }).optional(),
});
// IMPORTANT: toolExecutor is a runtime callback, NOT in Zod schema.
// The TypeScript type extends the schema:
export type AgentDef = z.infer<typeof AgentDefSchema> & {
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
};

// InboundEvent — discriminated union by mode
const InboundEventBase = {
  id: z.string(),
  surface: z.string(),
  channel: z.string().optional(),
  workspace: z.string().optional(),
  userId: z.string().optional(),
  payload: z.unknown(),
  meta: z.record(z.unknown()).optional(),
};

export const PlanEventSchema = z.object({
  ...InboundEventBase,
  mode: z.literal("plan"),
  agent: AgentDefSchema,
});
export type PlanEvent = z.infer<typeof PlanEventSchema> & { agent: AgentDef };

export const TeamEventSchema = z.object({
  ...InboundEventBase,
  mode: z.literal("team"),
  agents: z.object({
    reviewer: AgentDefSchema,
    executor: AgentDefSchema,
  }),
});
export type TeamEvent = z.infer<typeof TeamEventSchema> & {
  agents: { reviewer: AgentDef; executor: AgentDef };
};

export const DirectEventSchema = z.object({
  ...InboundEventBase,
  mode: z.literal("direct"),
  agent: AgentDefSchema,
});
export type DirectEvent = z.infer<typeof DirectEventSchema> & {
  agent: AgentDef;
};

export const InboundEventSchema = z.discriminatedUnion("mode", [
  PlanEventSchema,
  TeamEventSchema,
  DirectEventSchema,
]);
export type InboundEvent = PlanEvent | TeamEvent | DirectEvent;

// TeamResult — mirrors TeamOrchestrator.TeamResult (plain TS type, NOT Zod)
export type TeamResult = {
  status: "completed" | "stalled" | "failed";
  completedSteps: string[];
  failedSteps: string[];
  skippedSteps: string[];
  stallReason?: string;
  results: Map<string, string>;
};

// DirectResult
export type DirectResult = {
  output: string;
  finishReason: string;
};

// IngressResult — discriminated union return type from IngressEngine.ingest()
export type IngressResult =
  | { mode: "plan"; sessionId: string; result: PlanResult }
  | { mode: "team"; sessionId: string; result: TeamResult }
  | { mode: "direct"; sessionId: string; result: DirectResult };
