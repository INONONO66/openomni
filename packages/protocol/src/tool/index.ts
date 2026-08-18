import { z } from "zod";
import { Events as EventDescriptors } from "../event/tool.js";
import type { TraceContext } from "../trace/index.js";

export namespace Tool {
  /**
   * Compact runtime tool-catalog source discriminator.
   *
   * This intentionally does not replace Policy.Resource.Source policy provenance:
   * richer source metadata stays on catalog-specific fields such as `mcpServer`
   * or resource descriptors.
   */
  export const Source = z.enum(["system", "mcp", "agent", "server"]);
  export type Source = z.infer<typeof Source>;

  /**
   * Tool source provenance as a catalog label: `source:<Source>`. Producers
   * live in three packages and the consumer in a fourth, so the grammar is
   * defined once, here, next to the vocabulary it speaks — the two ends had
   * already drifted apart once (`source.mcp` vs `source:system`).
   */
  const sourceLabelPrefix = "source:";

  export function sourceLabel(source: Source): string {
    return `${sourceLabelPrefix}${source}`;
  }

  export function sourceFromLabels(labels: readonly string[] | undefined): Source | undefined {
    const label = labels?.find((candidate) => candidate.startsWith(sourceLabelPrefix));
    if (label === undefined) return undefined;
    const parsed = Source.safeParse(label.slice(sourceLabelPrefix.length));
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * MCP server provenance as a catalog label: `mcp.<serverId>`. Same
   * cross-package shape as the source label — two producers, one consumer —
   * so the same rule: the grammar is written once, here.
   */
  const mcpServerLabelPrefix = "mcp.";

  export function mcpServerLabel(serverId: string): string {
    return `${mcpServerLabelPrefix}${serverId}`;
  }

  export function mcpServerFromLabels(labels: readonly string[] | undefined): string | undefined {
    const label = labels?.find((candidate) => candidate.startsWith(mcpServerLabelPrefix));
    const serverId = label?.slice(mcpServerLabelPrefix.length);
    return serverId ? serverId : undefined;
  }

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

  const StatePending = z.object({
    status: z.literal("pending"),
    input: z.record(z.string(), z.unknown()),
  });

  const StateRunning = z.object({
    status: z.literal("running"),
    input: z.record(z.string(), z.unknown()),
    time: z.object({
      start: z.number(),
    }),
  });

  const StateCompleted = z.object({
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

  const StateError = z.object({
    status: z.literal("error"),
    input: z.record(z.string(), z.unknown()),
    error: z.string(),
    time: z.object({
      start: z.number(),
      end: z.number(),
    }),
  });

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

  /**
   * Per-call runtime context for tool execution callbacks. Cancellation is
   * cooperative: executors pass an aborted signal before returning timeout or
   * run-cancel results, and tools that start long-running work should stop their
   * own side effects when it aborts. This type documents the correlation fields
   * tools may receive; invocation owners must construct an exact runtime object
   * because TypeScript's structural typing does not remove additional fields.
   */
  export interface ExecutionContext {
    readonly signal?: AbortSignal;
    readonly traceContext?: Pick<TraceContext.Type, "traceId" | "sessionId" | "runId">;
  }

  export const Result = z.object({
    id: z.string(),
    toolCallId: z.string(),
    output: z.string(),
    isError: z.boolean().optional(),
    settlement: z.enum(["settled", "unknown"]).optional(),
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

  /** #499 observation descriptors — published via Bus; event name strings frozen. */
  export const Events = EventDescriptors;
}
