import type { Actor, Ingress } from "@openomni/protocol";
import type { ChannelGrantStore } from "@openomni/session";
import { actorTrustTier, getActor } from "./ingress-authority-actor";

export function channelGrantReason(
  grant: ChannelGrantStore.Grant | undefined,
  treatment: string | undefined,
): string {
  if (!grant) return "channel_grant.missing";
  return `channel_grant.${grant.kind}.${treatment ?? "unknown"}`;
}

export function applyChannelGrantTreatment(
  event: Ingress.InboundEvent,
  grant: ChannelGrantStore.Grant,
  inboundTreatment: Actor.InboundTreatment,
): Ingress.InboundEvent {
  const actor = getActor(event);
  const actorWithChannelDefault =
    actor && !actorTrustTier(actor) && grant.defaultTier
      ? { ...actor, trustTier: grant.defaultTier }
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
