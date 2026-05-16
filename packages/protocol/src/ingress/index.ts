import { z } from "zod";
import { Policy } from "../policy/index.js";
import { Tool } from "../tool/index.js";

const AgentToolConfigSchema = z.object({
  systemTools: z.array(z.string()).optional(),
  agentTools: z.array(z.string()).optional(),
  mcpTools: z.array(z.string()).optional(),
  workspaceRoot: z.string().optional(),
});

const ActorSchemaImpl = z
  .object({
    id: z.string().optional(),
    role: z.string().optional(),
    kind: z.string().optional(),
    type: z.string().optional(),
    sessionId: z.string().optional(),
    workerId: z.string().optional(),
    trusted: z.boolean().optional(),
    isTrustedManager: z.boolean().optional(),
    isMain: z.boolean().optional(),
  })
  .catchall(z.unknown());

const RawTargetSchema = z
  .object({
    kind: z.enum(["main", "new-worker", "worker"]),
    workerId: z.string().optional(),
    sessionId: z.string().optional(),
    parentSessionId: z.string().optional(),
  })
  .catchall(z.unknown())
  .refine((target) => target.kind !== "worker" || Boolean(target.workerId || target.sessionId), {
    message: "worker target requires workerId or sessionId",
  });

const TargetSchemaImpl = z.preprocess((input) => {
  if (input === "main") return { kind: "main" };
  if (input === "new-worker") return { kind: "new-worker" };
  if (typeof input === "string" && input.startsWith("worker:")) {
    const id = input.slice("worker:".length);
    return { kind: "worker", workerId: id };
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.type === "string" && record.kind === undefined) {
      const { type, ...rest } = record;
      return { ...rest, kind: type };
    }
  }
  return input;
}, RawTargetSchema);

const ActivationMetadataSchemaImpl = z
  .object({
    durableSessionId: z.string().optional(),
    activationId: z.string().optional(),
    runId: z.string().optional(),
    lifecycle: z
      .enum([
        "sleeping",
        "hydrating",
        "active",
        "idle",
        "releasing",
        "starting",
        "ready",
        "busy",
        "stopping",
        "exited",
      ])
      .optional(),
  })
  .catchall(z.unknown());

const MetaSchemaImpl = z
  .object({
    actor: ActorSchemaImpl.optional(),
    target: TargetSchemaImpl.optional(),
  })
  .catchall(z.unknown());

export namespace Ingress {
  export const ActorSchema = ActorSchemaImpl;
  export type Actor = z.infer<typeof ActorSchema>;
  export type ActorMetadata = Actor;

  export const TargetSchema = TargetSchemaImpl;
  export type Target = z.infer<typeof TargetSchema>;

  export const MetaSchema = MetaSchemaImpl;
  export type Meta = z.infer<typeof MetaSchema>;
  export type EventMetadata = Meta;

  export const ActivationMetadataSchema = ActivationMetadataSchemaImpl;
  export type ActivationMetadata = z.infer<typeof ActivationMetadataSchema>;

  export const AgentDefSchema = z
    .object({
      model: z.object({ provider: z.string(), id: z.string() }),
      systemPrompt: z.string().optional(),
      tools: z.array(Tool.Spec).optional(),
      budget: z.object({ maxTurns: z.number().optional() }).optional(),
      permissions: Policy.Permission.optional(),
      policyPlan: Policy.PolicyPlan.optional(),
      toolConfig: AgentToolConfigSchema.optional(),
    })
    .passthrough();
  // Runtime callbacks can't be expressed in Zod.
  export type AgentDef = z.infer<typeof AgentDefSchema> & {
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
    toolExecutorFactory?: (ctx: {
      sessionId: string;
      runId: string;
      agentName?: string;
      workspaceRoot?: string;
    }) => (call: Tool.Call) => Promise<Tool.Result>;
  };

  const InboundEventBase = {
    id: z.string(),
    surface: z.string(),
    channel: z.string().optional(),
    workspace: z.string().optional(),
    userId: z.string().optional(),
    payload: z.unknown(),
    target: TargetSchemaImpl.optional(),
    meta: MetaSchemaImpl.optional(),
    runtime: ActivationMetadataSchemaImpl.optional(),
  };

  export const DirectEventSchema = z.object({
    ...InboundEventBase,
    mode: z.literal("direct"),
    agent: AgentDefSchema,
  });
  export type DirectEvent = z.infer<typeof DirectEventSchema> & { agent: AgentDef };

  export const InboundEventSchema = DirectEventSchema;
  export type InboundEvent = DirectEvent;

  export function resolveTarget(event: { target?: Target; meta?: { target?: Target } }): Target {
    if (event.target) return TargetSchema.parse(event.target);
    if (event.meta?.target) return TargetSchema.parse(event.meta.target);
    return { kind: "main" };
  }

  export function targetKey(target: Target): string {
    if (target.kind === "main") return target.sessionId ? `main:${target.sessionId}` : "main";
    if (target.kind === "new-worker") {
      return target.workerId ? `new-worker:${target.workerId}` : "new-worker";
    }
    return target.sessionId ? `worker-session:${target.sessionId}` : `worker:${target.workerId}`;
  }

  export type DirectResult = {
    output: string;
    finishReason: string;
  };

  export type IngressResult = {
    mode: "direct";
    target: Target;
    sessionId: string;
    result: DirectResult;
  };
}
