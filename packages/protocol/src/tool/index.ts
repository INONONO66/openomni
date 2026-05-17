import { z } from "zod";

export namespace Tool {
  /**
   * Compact runtime tool-catalog source discriminator.
   *
   * This intentionally does not replace RuntimeResource.Source policy provenance:
   * richer source metadata stays on catalog-specific fields such as `mcpServer`
   * or resource descriptors.
   */
  export const Source = z.enum(["system", "mcp", "agent", "server"]);
  export type Source = z.infer<typeof Source>;

  export const RiskTier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
  export type RiskTier = z.infer<typeof RiskTier>;

  /**
   * Shared tool exposure config accepted at ingress and execution boundaries.
   *
   * `workspaceRoot` is the existing workspace selector for tool resolution; keep
   * broader execution-environment settings on execution-level contracts instead
   * of growing this shape.
   */
  export const Config = z.object({
    systemTools: z.array(z.string()).optional(),
    agentTools: z.array(z.string()).optional(),
    mcpTools: z.array(z.string()).optional(),
    workspaceRoot: z.string().optional(),
  });
  export type Config = z.infer<typeof Config>;

  export const StatePending = z.object({
    status: z.literal("pending"),
    input: z.record(z.string(), z.unknown()),
  });
  export type StatePending = z.infer<typeof StatePending>;

  export const StateRunning = z.object({
    status: z.literal("running"),
    input: z.record(z.string(), z.unknown()),
    time: z.object({
      start: z.number(),
    }),
  });
  export type StateRunning = z.infer<typeof StateRunning>;

  export const StateCompleted = z.object({
    status: z.literal("completed"),
    input: z.record(z.string(), z.unknown()),
    output: z.string(),
    title: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    time: z.object({
      start: z.number(),
      end: z.number(),
    }),
  });
  export type StateCompleted = z.infer<typeof StateCompleted>;

  export const StateError = z.object({
    status: z.literal("error"),
    input: z.record(z.string(), z.unknown()),
    error: z.string(),
    time: z.object({
      start: z.number(),
      end: z.number(),
    }),
  });
  export type StateError = z.infer<typeof StateError>;

  export const State = z.discriminatedUnion("status", [
    StatePending,
    StateRunning,
    StateCompleted,
    StateError,
  ]);
  export type State = z.infer<typeof State>;

  export const Call = z.object({
    id: z.string(),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()),
  });
  export type Call = z.infer<typeof Call>;

  export const Result = z.object({
    id: z.string(),
    toolCallId: z.string(),
    output: z.string(),
    isError: z.boolean().optional(),
  });
  export type Result = z.infer<typeof Result>;

  export const Spec = z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    safe: z.boolean().optional(),
    labels: z.array(z.string()).optional(),
    prompt: z.string().optional(),
  });
  export type Spec = z.infer<typeof Spec>;
}
