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
  event: Ingress.DirectEvent,
  grant: ChannelGrantStore.Grant,
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
