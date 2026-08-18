import { z } from "zod";
import { Actor } from "../actor/index.js";
import { CommandSchemas } from "../command/schemas.js";
import { Model } from "../model/index.js";
import { Policy } from "../policy/index.js";
import { Tool } from "../tool/index.js";

const ActorSchemaImpl = z
  .object({
    id: z.string().optional(),
    actorId: z.string().optional(),
    role: z.string().optional(),
    kind: z.string().optional(),
    type: z.string().optional(),
    trustTier: Actor.TrustTier.optional(),
    endpointId: z.string().optional(),
    endpoint: Actor.Endpoint.optional(),
    sessionId: z.string().optional(),
    workerId: z.string().optional(),
    isResident: z.boolean().optional(),
    isMain: z.boolean().optional(),
  })
  .catchall(z.unknown());

/**
 * #498 C2: the ingress seam narrows THE one Command.Target vocabulary to its
 * two executable kinds. `workerId` is the string-form ("worker:<id>") wire
 * artifact this seam owns; every shared field is picked from Command.Target,
 * and the catchall keeps the historical tolerance for extra inbound keys.
 */
const RawTargetSchema = CommandSchemas.Target.pick({
  sessionId: true,
  parentSessionId: true,
})
  .extend({
    kind: CommandSchemas.TargetKind.extract(["resident", "worker"]),
    workerId: z.string().optional(),
  })
  .catchall(z.unknown());

const TargetSchemaImpl = z.preprocess((input) => {
  if (input === "resident") return { kind: "resident" };
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
    trigger: z
      .object({
        kind: z.enum(["cron", "webhook", "manual", "internal"]),
        id: z.string().optional(),
        scheduledAt: z.number().optional(),
        firedAt: z.number().optional(),
        attempt: z.number().optional(),
      })
      .catchall(z.unknown())
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

  export const TargetSchema = TargetSchemaImpl;
  export type Target = z.infer<typeof TargetSchema>;

  export const MetaSchema = MetaSchemaImpl;
  export type Meta = z.infer<typeof MetaSchema>;

  export type ActivationMetadata = z.infer<typeof ActivationMetadataSchemaImpl>;

  export const AgentDefSchema = z
    .object({
      model: Model.Ref,
      systemPrompt: z.string().optional(),
      tools: z.array(Tool.Spec).optional(),
      budget: Actor.Profile.Budget.optional(),
      permissions: Policy.Permission.optional(),
      policyPlan: Policy.PolicyPlan.optional(),
      toolConfig: Tool.Config.optional(),
    })
    .passthrough();
  // Runtime callbacks can't be expressed in Zod.
  export type AgentDef = z.infer<typeof AgentDefSchema> & {
    toolExecutor?: (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
    toolExecutorFactory?: (ctx: {
      sessionId: string;
      runId: string;
      agentName?: string;
      workspaceRoot?: string;
    }) => (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
  };

  const InboundEventBase = {
    id: z.string(),
    /** D11: minted once at the producer's first frame (channel surface, cron fire, dispatch command) — ingress inherits, never re-mints. */
    traceId: z.string(),
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

  export const InternalEventSchema = z.object({
    ...InboundEventBase,
    mode: z.literal("internal"),
    agentName: z.string(),
  });
  export type InternalEvent = z.infer<typeof InternalEventSchema>;

  export const InboundEventSchema = z.discriminatedUnion("mode", [
    DirectEventSchema,
    InternalEventSchema,
  ]);
  export type InboundEvent = DirectEvent | InternalEvent;
  export type ResolvedInboundEvent = DirectEvent | (InternalEvent & { agent: AgentDef });

  type DirectResult = {
    output: string;
    finishReason: string;
  };

  export type ExecutedIngressResult = {
    kind?: "executed";
    mode: "direct" | "internal";
    target: Target;
    sessionId: string;
    result: DirectResult;
  };

  export type DroppedIngressResult = {
    kind: "dropped";
    mode: "direct" | "internal";
    target: Target;
    reason: string;
  };

  export type IngressResult = ExecutedIngressResult | DroppedIngressResult;
}
