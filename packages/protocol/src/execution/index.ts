import { z } from "zod";
import { AgentProfile } from "../agent/index.js";
import { Model } from "../model/index.js";
import { Policy } from "../policy/index.js";
import { Token } from "../token/index.js";
import { Tool } from "../tool/index.js";

const requestSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  mode: z.literal("direct"),
  prompt: z.string(),
  model: Model.Ref,
  systemPrompt: z.string().optional(),
  tools: z.array(Tool.Spec).optional(),
  toolConfig: Tool.Config.optional(),
  permissions: Policy.Permission.optional(),
  credentials: z.record(z.string()).optional(),
  budget: AgentProfile.AgentBudget.optional(),
  skills: z.array(z.string()).optional(),
  agentName: z.string().optional(),
  workspaceRoot: z.string().optional(),
  middleware: z.array(z.string()).optional(),
  policyPlan: Policy.PolicyPlan.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  traceId: z.string().optional(),
});

const localCliLogEventSchema = z.object({
  kind: z.literal("local_cli_log_event"),
  artifactId: z.string(),
  message: z.string(),
  timestamp: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()),
});

const resultSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
  output: z.string().optional(),
  finishReason: z.string().optional(),
  usage: Token.ExecutionUsage.optional(),
  error: z.string().optional(),
  artifacts: z
    .array(
      z.object({
        kind: z.literal("local_cli_log"),
        artifactId: z.string(),
        title: z.string(),
        mimeType: z.string(),
      }),
    )
    .optional(),
  logEvents: z.array(localCliLogEventSchema).optional(),
});

export namespace Execution {
  export const LogEvent = localCliLogEventSchema;
  export type LogEvent = z.infer<typeof LogEvent>;

  export const Request = requestSchema;
  export type Request = z.infer<typeof requestSchema>;

  export const Result = resultSchema;
  export type Result = z.infer<typeof resultSchema>;
}
