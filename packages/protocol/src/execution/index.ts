import { z } from "zod";
import { Tool } from "../tool/index.js";
import { Guardrail } from "../guardrail/index.js";
import { AgentProfile } from "../agent/index.js";

const requestSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  mode: z.enum(["direct", "plan"]),
  prompt: z.string(),
  model: z.object({
    provider: z.string(),
    id: z.string(),
  }),
  systemPrompt: z.string().optional(),
  tools: z.array(Tool.Spec).optional(),
  toolConfig: z
    .object({
      systemTools: z.array(z.string()).optional(),
      agentTools: z.array(z.string()).optional(),
      mcpTools: z.array(z.string()).optional(),
      workspaceRoot: z.string().optional(),
    })
    .optional(),
  permissions: Guardrail.Permission.optional(),
  credentials: z.record(z.string()).optional(),
  budget: AgentProfile.AgentBudget.optional(),
  skills: z.array(z.string()).optional(),
  agentName: z.string().optional(),
  workspaceRoot: z.string().optional(),
  middleware: z.array(z.string()).optional(),
  traceId: z.string().optional(),
});

const resultSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
  output: z.string().optional(),
  finishReason: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
  error: z.string().optional(),
});

export namespace Execution {
  export const Request = requestSchema;
  export type Request = z.infer<typeof requestSchema>;

  export const Result = resultSchema;
  export type Result = z.infer<typeof resultSchema>;
}
