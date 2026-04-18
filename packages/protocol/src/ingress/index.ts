import { z } from "zod";
import { Guardrail } from "../guardrail/index.js";
import { Tool } from "../tool/index.js";
import type { Plan } from "../plan/index.js";

const AgentToolConfigSchema = z.object({
  systemTools: z.array(z.string()).optional(),
  agentTools: z.array(z.string()).optional(),
  mcpTools: z.array(z.string()).optional(),
  workspaceRoot: z.string().optional(),
});

export namespace Ingress {
  export const AgentDefSchema = z.object({
    model: z.object({ provider: z.string(), id: z.string() }),
    systemPrompt: z.string().optional(),
    tools: z.array(Tool.Spec).optional(),
    budget: z.object({ maxTurns: z.number().optional() }).optional(),
    permissions: Guardrail.ToolPermission.optional(),
    toolConfig: AgentToolConfigSchema.optional(),
  });
  // toolExecutor is a runtime callback — can't be expressed in Zod
  export type AgentDef = z.infer<typeof AgentDefSchema> & {
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  };

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

  export const DirectEventSchema = z.object({
    ...InboundEventBase,
    mode: z.literal("direct"),
    agent: AgentDefSchema,
  });
  export type DirectEvent = z.infer<typeof DirectEventSchema> & { agent: AgentDef };

  export const InboundEventSchema = z.discriminatedUnion("mode", [
    PlanEventSchema,
    DirectEventSchema,
  ]);
  export type InboundEvent = PlanEvent | DirectEvent;

  export type DirectResult = {
    output: string;
    finishReason: string;
  };

  export type IngressResult =
    | { mode: "plan"; sessionId: string; result: Plan.Result }
    | { mode: "direct"; sessionId: string; result: DirectResult };
}
