import { Storage, type ActorRegistry } from "@openomni/ledger";
import { canonicalDigest, PlainValueSchema } from "@openomni/protocol";
import { z } from "zod";
import { defineTool, ToolRefused } from "@openomni/agent";

export interface ApprovalPort {
  readonly getIdentity: typeof ActorRegistry.getIdentity;
  readonly getEndpoint: typeof ActorRegistry.getEndpoint;
  readonly promote: typeof ActorRegistry.promote;
  readonly mergeEndpoint: typeof ActorRegistry.mergeEndpoint;
}

const ApprovalInput = z
  .object({
    operation: z.discriminatedUnion("op", [
      z.object({ op: z.literal("contact_promote"), actorId: z.string().min(1) }).strict(),
      z
        .object({
          op: z.literal("endpoint_merge"),
          endpointId: z.string().min(1),
          toActorId: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict();
const ApprovalOutput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("contact_promote"), id: z.string(), trustTier: z.string() }).strict(),
  z.object({ op: z.literal("endpoint_merge"), id: z.string(), actorId: z.string() }).strict(),
]);

/** Actor rows have no monotonic revision, so the precondition keys retain their entire digest. */
export function authorityDomainRevisions(
  port: ApprovalPort,
  input: z.output<typeof ApprovalInput>,
): Record<string, number> {
  const operation = input.operation;
  if (operation.op === "contact_promote") {
    const identity = port.getIdentity(operation.actorId);
    return {
      [`identity:${operation.actorId}:${canonicalDigest(PlainValueSchema.parse(identity ?? null))}`]: 0,
    };
  }
  const endpoint = port.getEndpoint(operation.endpointId);
  const target = port.getIdentity(operation.toActorId);
  const source = endpoint === undefined ? undefined : port.getIdentity(endpoint.actorId);
  return {
    [`endpoint:${operation.endpointId}:${canonicalDigest(PlainValueSchema.parse(endpoint ?? null))}`]: 0,
    [`identity:${operation.toActorId}:${canonicalDigest(PlainValueSchema.parse(target ?? null))}`]: 0,
    [`source:${endpoint?.actorId ?? operation.endpointId}:${canonicalDigest(PlainValueSchema.parse(source ?? null))}`]: 0,
  };
}

/** The model can ask for an act, never mint consent or reconstruct an approved act. */
export function createApprovalTool(port: ApprovalPort) {
  return defineTool(
    {
      name: "approval",
      category: "authority",
      description:
        "Promote a contact or merge an endpoint. The original invocation suspends for authenticated Owner consent.",
      input: ApprovalInput,
      output: ApprovalOutput,
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: async ({ operation }, context) => Storage.get().transaction(() => {
        if (context.domainRevisions === undefined || canonicalDigest({ ...context.domainRevisions }) !== canonicalDigest(authorityDomainRevisions(port, { operation }))) {
          throw new ToolRefused("approval", "domain revision changed");
        }
        if (operation.op === "contact_promote") {
          const identity = port.getIdentity(operation.actorId);
          if (identity === undefined || identity.standing !== "provisional")
            throw new ToolRefused("contact_promote", "contact is missing or already registered");
          const promoted = port.promote(operation.actorId);
          return { op: operation.op, id: promoted.id, trustTier: promoted.trustTier };
        }
        const endpoint = port.getEndpoint(operation.endpointId);
        if (
          endpoint === undefined ||
          port.getIdentity(operation.toActorId) === undefined ||
          endpoint.actorId === operation.toActorId
        )
          throw new ToolRefused(
            "endpoint_merge",
            "endpoint or target is missing, or already bound",
          );
        const merged = port.mergeEndpoint(operation.endpointId, operation.toActorId);
        return { op: operation.op, id: merged.id, actorId: merged.actorId };
      }),
      render: (_args, value) =>
        value.op === "contact_promote"
          ? `contact ${value.id} registered (tier ${value.trustTier})`
          : `endpoint ${value.id} merged into ${value.actorId}`,
    },
    (input) => ({ required: true, domainRevisions: authorityDomainRevisions(port, input) }),
  );
}
