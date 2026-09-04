import { z } from "zod";
import { Events as EventDescriptors } from "../event/tool.js";
import { CapabilityId } from "../machine/schema.js";
import type { TraceContext } from "../trace/index.js";
import { EpochMs } from "../time.js";

export type ToolCategory = "query" | "mutation" | "authority" | "execution";
export type ToolRole = "resident" | "worker";

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
}

/** Protocol shape only; definition validation and dispatch live in agent. */
export interface ToolDefinition<In extends z.ZodType = z.ZodType, Out extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly input: In;
  readonly output: Out;
  readonly visibility: {
    readonly model: readonly ToolRole[];
    readonly cell: readonly ToolRole[];
  };
  readonly sequential?: true;
  execute(args: z.output<In>, ctx: ToolExecutionContext): Promise<z.output<Out>>;
  render(args: z.output<In>, value: z.output<Out>): string;
}

export type AnyToolDefinition = ToolDefinition<z.ZodType, z.ZodType>;

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

  /** Tool source provenance reader for catalog labels shaped as `source:<Source>`. */
  const sourceLabelPrefix = "source:";

  export function sourceFromLabels(labels: readonly string[] | undefined): Source | undefined {
    const label = labels?.find((candidate) => candidate.startsWith(sourceLabelPrefix));
    if (label === undefined) return undefined;
    const parsed = Source.safeParse(label.slice(sourceLabelPrefix.length));
    return parsed.success ? parsed.data : undefined;
  }

  /** MCP server provenance reader for catalog labels shaped as `mcp.<serverId>`. */
  const mcpServerLabelPrefix = "mcp.";

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
      start: EpochMs,
    }),
  });

  const StateCompleted = z.object({
    status: z.literal("completed"),
    input: z.record(z.string(), z.unknown()),
    output: z.string(),
    title: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    time: z.object({
      start: EpochMs,
      end: EpochMs,
    }),
  });

  const StateError = z.object({
    status: z.literal("error"),
    input: z.record(z.string(), z.unknown()),
    error: z.string(),
    time: z.object({
      start: EpochMs,
      end: EpochMs,
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
    /**
     * #500 C4: denormalized tool name, populated by producers that have the
     * name in hand at result construction. Additive-optional — readers must
     * tolerate absence (older producers, and paths where only the call id
     * survives).
     */
    toolName: z.string().optional(),
    output: z.string(),
    isError: z.boolean().optional(),
    settlement: z.enum(["settled", "unknown"]).optional(),
  });
  export type Result = z.infer<typeof Result>;

  /**
   * Tool-catalog selection vocabulary — one noun namespace for the tool
   * grammar, consumed by the openomni tool catalog resolver.
   */
  export const Category = z.enum(["filesystem", "execution", "delegation", "mcp", "custom"]);
  export type Category = z.infer<typeof Category>;

  export const Selection = z.object({
    all: z.boolean().optional(),
    categories: z.array(Category).optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  });
  export type Selection = z.infer<typeof Selection>;

  /**
   * Where a tool's effect happens (docs/machines-and-delegation.md §4):
   * `machine` — on an attached machine's daemon; `host` — on the brain's own
   * host process; `free` — anywhere (pure/network tools). The Spec field is
   * additive-optional so every existing spec stays valid; the catalog
   * resolver (the placement consumer, machines-and-delegation.md §5 stage 4)
   * is the single owner of the absent-means-`free` read. The mutation axis
   * is the existing `safe` field (safe === false is what the design doc
   * calls "mutates"), so no second spelling of that convention exists.
   */
  export const Placement = z.enum(["machine", "host", "free"]);
  export type Placement = z.infer<typeof Placement>;

  export const Spec = z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    safe: z.boolean().optional(),
    labels: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    placement: Placement.optional(),
    /** Capabilities the executing side must hold (Machine.CapabilityId grammar). */
    requires: z.array(CapabilityId).optional(),
  });
  export type Spec = z.infer<typeof Spec>;

  /**
   * Every identity an executor may dispatch a tool by: its catalog name plus
   * the dot-to-underscore spelling executors register for providers that
   * reject dots. Single owner of that convention — dispatch-table builders
   * and the placement execution gate both read it, so a tool can never be
   * runnable under a name one side does not know about.
   */
  export function executableNames(name: string): readonly string[] {
    const sanitized = name.replace(/\./g, "_");
    return sanitized === name ? [name] : [name, sanitized];
  }

  /** #499 observation descriptors — published via Bus; event name strings frozen. */
  export const Events = EventDescriptors;
}
