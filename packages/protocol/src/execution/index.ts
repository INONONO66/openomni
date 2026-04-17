import { z } from "zod";
import { Tool } from "../tool/index.js";

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
  permissions: z
    .object({
      denylist: z.array(z.string()).optional(),
      allowlist: z.array(z.string()).optional(),
    })
    .optional(),
  credentials: z.record(z.string()).optional(),
  budget: z
    .object({
      maxTurns: z.number().optional(),
      maxTokens: z.number().optional(),
    })
    .optional(),
  skills: z.array(z.string()).optional(),
  workspace: z.string().optional(),
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
