import { z } from "zod";
import { Events as EventDescriptors } from "../event/tool.js";
import { CapabilityId } from "../machine/schema.js";
import type { TraceContext } from "../trace/index.js";
import { PlainObjectSchema, PlainValueSchema } from "../json.js";
import { EpochMs } from "../time.js";
import { toolResultSchema } from "./result.js";

export type ToolCategory = "query" | "mutation" | "authority" | "execution";
export type ToolRole = "resident" | "worker";

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly domainRevisions?: Readonly<Record<string, number>>;
}

/** Protocol shape only; definition validation and dispatch live in agent. */
export interface ToolDefinition<
  In extends z.ZodType = z.ZodType,
  Out extends z.ZodType = z.ZodType,
> {
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
    input: PlainObjectSchema,
  });

  const StateRunning = z.object({
    status: z.literal("running"),
    input: PlainObjectSchema,
    time: z.object({
      start: EpochMs,
    }),
  });

  const StateCompleted = z.object({
    status: z.literal("completed"),
    input: PlainObjectSchema,
    output: z.string(),
    title: z.string(),
    metadata: z.record(z.string(), PlainValueSchema),
    time: z.object({
      start: EpochMs,
      end: EpochMs,
    }),
  });

  const StateError = z.object({
    status: z.literal("error"),
    input: PlainObjectSchema,
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
    input: PlainObjectSchema,
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

  export const Result = toolResultSchema();
  export type Result = z.infer<typeof Result>;

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
    inputSchema: PlainObjectSchema,
    safe: z.boolean().optional(),
    sequential: z.literal(true).optional(),
    labels: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    placement: Placement.optional(),
    /** Capabilities the executing side must hold (Machine.CapabilityId grammar). */
    requires: z.array(CapabilityId).optional(),
  });
  export type Spec = z.infer<typeof Spec>;

  /** #499 observation descriptors — published via Bus; event name strings frozen. */
  export const Events = EventDescriptors;
}
