import type { Actor, Ingress } from "@openomni/protocol";

import { actorTrustTier, getActor } from "./ingress-authority-actor";

export function channelGrantReason(
  grant: Actor.ChannelGrant | undefined,
  treatment: string | undefined,
): string {
  if (!grant) return "channel_grant.missing";
  return `channel_grant.${grant.kind}.${treatment ?? "unknown"}`;
}

export function resolveInboundTreatment(grant: Actor.ChannelGrant): Actor.InboundTreatment {
  if (grant.inboundTreatment !== undefined) return grant.inboundTreatment;
  if (grant.kind === "trusted_channel") return "full_access";
  if (grant.kind === "broadcast_channel") return "evidence_only";
  return "drop";
}

export function applyChannelGrantTreatment(
  event: Ingress.DirectEvent,
  grant: Actor.ChannelGrant,
  inboundTreatment: Actor.InboundTreatment,
): Ingress.DirectEvent {
  const actor = getActor(event);
  const actorWithChannelDefault =
    !actorTrustTier(actor) && grant.defaultTier
      ? { ...(actor ?? { role: "user" }), trustTier: grant.defaultTier }
      : actor;

  return {
    ...event,
    meta: {
      ...event.meta,
      ...(actorWithChannelDefault ? { actor: actorWithChannelDefault } : {}),
      channelGrantId: grant.id,
      channelGrantKind: grant.kind,
      inboundTreatment,
    },
  };
}
