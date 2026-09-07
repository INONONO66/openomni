import { ToolRefused } from "@openomni/agent";
import { ActorRegistry, Storage } from "@openomni/ledger";
import { canonicalDigest, PlainValueSchema } from "@openomni/protocol";
import { z } from "zod";

export const CONTACT_PROMOTE_INPUT = z.object({ actorId: z.string().min(1) }).strict();
export const CONTACT_MERGE_INPUT = z
  .object({ endpointId: z.string().min(1), toActorId: z.string().min(1) })
  .strict();

export const ContactOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("contact_promote"), args: CONTACT_PROMOTE_INPUT }).strict(),
  z.object({ op: z.literal("contact_merge"), args: CONTACT_MERGE_INPUT }).strict(),
]);
type ContactOperation = z.output<typeof ContactOperation>;

export const ContactResult = z.discriminatedUnion("op", [
  z.object({ op: z.literal("contact_promote"), id: z.string(), trustTier: z.string() }).strict(),
  z.object({ op: z.literal("contact_merge"), id: z.string(), actorId: z.string() }).strict(),
]);

const digestKey = (kind: string, id: string, row: unknown) =>
  `${kind}:${id}:${canonicalDigest(PlainValueSchema.parse(row ?? null))}`;

/** Actor rows carry no monotonic revision, so every participating row binds by digest. */
export function contactDomainRevisions(operation: ContactOperation): Record<string, number> {
  if (operation.op === "contact_promote") {
    const { actorId } = operation.args;
    return { [digestKey("identity", actorId, ActorRegistry.getIdentity(actorId))]: 0 };
  }
  const { endpointId, toActorId } = operation.args;
  const endpoint = ActorRegistry.getEndpoint(endpointId);
  const source = endpoint === undefined ? undefined : ActorRegistry.getIdentity(endpoint.actorId);
  return {
    [digestKey("endpoint", endpointId, endpoint)]: 0,
    [digestKey("identity", toActorId, ActorRegistry.getIdentity(toActorId))]: 0,
    [digestKey("source", endpoint?.actorId ?? endpointId, source)]: 0,
  };
}

/**
 * Body-entry domain CAS inside one transaction. Consent itself is the kernel
 * request the `require_approval` policy row opened; this layer only refuses to
 * spend it on rows that changed since the Owner saw them.
 */
export function mutateContact(
  operation: ContactOperation,
  revisions: Readonly<Record<string, number>> | undefined,
): z.output<typeof ContactResult> {
  return Storage.get().transaction(() => {
    if (
      revisions === undefined ||
      canonicalDigest({ ...revisions }) !== canonicalDigest(contactDomainRevisions(operation))
    )
      throw new ToolRefused(operation.op, "domain revision changed");
    if (operation.op === "contact_promote") {
      const identity = ActorRegistry.getIdentity(operation.args.actorId);
      if (identity === undefined || identity.standing !== "provisional")
        throw new ToolRefused(operation.op, "contact is missing or already registered");
      const promoted = ActorRegistry.promote(operation.args.actorId);
      return { op: operation.op, id: promoted.id, trustTier: promoted.trustTier };
    }
    const { endpointId, toActorId } = operation.args;
    const endpoint = ActorRegistry.getEndpoint(endpointId);
    if (
      endpoint === undefined ||
      ActorRegistry.getIdentity(toActorId) === undefined ||
      endpoint.actorId === toActorId
    )
      throw new ToolRefused(operation.op, "endpoint or target is missing, or already bound");
    const merged = ActorRegistry.mergeEndpoint(endpointId, toActorId);
    return { op: operation.op, id: merged.id, actorId: merged.actorId };
  });
}
