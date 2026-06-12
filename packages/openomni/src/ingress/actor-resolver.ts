import type { Ingress } from "@openomni/protocol";
import { ActorRegistry, Storage } from "@openomni/session";

function legacyActorFields(actor: Ingress.Actor | undefined): Ingress.Actor | undefined {
  if (!actor) return undefined;
  const legacyActor: Ingress.Actor = {};
  if (actor.id) legacyActor.id = actor.id;
  if (actor.role) legacyActor.role = actor.role;
  return legacyActor;
}

function externalActorId(event: Ingress.InboundEvent): string | undefined {
  return event.userId;
}

export function resolveIngressActor(event: Ingress.InboundEvent): Ingress.InboundEvent {
  const externalId = externalActorId(event);
  if (!externalId || !Storage.get().actorRegistry) {
    return {
      ...event,
      meta: {
        ...event.meta,
        actor: legacyActorFields(event.meta?.actor),
      },
    };
  }

  const resolved = ActorRegistry.resolveEndpoint(event.surface, externalId, event.workspace);
  if (!resolved) {
    return {
      ...event,
      meta: {
        ...event.meta,
        actor: legacyActorFields(event.meta?.actor),
      },
    };
  }

  return {
    ...event,
    meta: {
      ...event.meta,
      actor: {
        id: resolved.endpoint.externalId,
        role: "user",
        actorId: resolved.identity.id,
        kind: resolved.identity.kind,
        trustTier: resolved.identity.trustTier,
        relationship: resolved.identity.relationship,
        endpointId: resolved.endpoint.id,
        endpoint: resolved.endpoint,
      },
    },
  };
}
