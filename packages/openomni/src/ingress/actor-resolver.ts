import type { Actor, Ingress, Ledger } from "@openomni/protocol";

export interface AuthoritySourceRefs {
  readonly sourceEventId: string;
  readonly sourceOwnerSeq: number;
  readonly sourceLedgerSeq: number;
  readonly sourceOwnerHash: string;
  readonly asOfLedgerSeq: number;
}
export type WorkerGrantProjectionV1 = Readonly<{
  id: string;
  attempt: Ledger.AttemptRefV1;
  status: "active" | "revoked" | "expired";
  version: number;
  allowedActions: readonly string[];
  allowedSessionIds?: readonly string[];
  allowedActorIds?: readonly string[];
  allowedEndpointIds?: readonly string[];
  canCreateExternalTasks: boolean;
  riskCeiling?: "low" | "medium" | "high";
  expiresAt?: number;
}>;

export type AuthorityProjectionQueryRequest =
  | Readonly<{
      kind: "authority.actor_by_endpoint";
      surface: string;
      externalId: string;
      workspace?: string;
    }>
  | Readonly<{
      kind: "authority.blacklist_match";
      actorId?: string;
      endpointId?: string;
      channel?: string;
      candidates: readonly string[];
    }>
  | Readonly<{
      kind: "authority.channel_grant";
      surface: string;
      workspace?: string;
      channel?: string;
    }>
  | Readonly<{
      kind: "authority.worker_grant";
      target: Readonly<{ sessionId: string; runId: string }>;
    }>;

export type AuthorityProjectionQueryResult =
  | (AuthoritySourceRefs &
      Readonly<{
        kind: "authority.actor_by_endpoint";
        endpointSourceRefs: AuthoritySourceRefs | null;
        identitySourceRefs: AuthoritySourceRefs | null;
        identity: Actor.Identity | null;
        endpoint: Actor.Endpoint | null;
      }>)
  | (AuthoritySourceRefs &
      Readonly<{
        kind: "authority.blacklist_match";
        entry: Actor.BlacklistEntry | null;
      }>)
  | (AuthoritySourceRefs &
      Readonly<{
        kind: "authority.channel_grant";
        grant: Actor.ChannelGrant | null;
      }>)
  | (AuthoritySourceRefs &
      Readonly<{
        kind: "authority.worker_grant";
        grant: WorkerGrantProjectionV1 | null;
      }>);

export interface AuthorityProjectionQueryPort {
  query(request: AuthorityProjectionQueryRequest): Promise<AuthorityProjectionQueryResult>;
}

export function authoritySourceFacts(refs: AuthoritySourceRefs): string[] {
  return [
    `authority.source_event:${refs.sourceEventId}`,
    `authority.source_owner_seq:${refs.sourceOwnerSeq}`,
    `authority.source_ledger_seq:${refs.sourceLedgerSeq}`,
    `authority.source_owner_hash:${refs.sourceOwnerHash}`,
    `authority.as_of_ledger_seq:${refs.asOfLedgerSeq}`,
  ];
}

export function authoritySourceRefs(value: unknown): AuthoritySourceRefs | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const refs = value as Partial<AuthoritySourceRefs>;
  if (
    typeof refs.sourceEventId !== "string" ||
    !Number.isSafeInteger(refs.sourceOwnerSeq) ||
    !Number.isSafeInteger(refs.sourceLedgerSeq) ||
    typeof refs.sourceOwnerHash !== "string" ||
    !Number.isSafeInteger(refs.asOfLedgerSeq)
  ) {
    return undefined;
  }
  return refs as AuthoritySourceRefs;
}

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

function unresolvedActor(
  event: Ingress.InboundEvent,
  evidence?: AuthoritySourceRefs,
): Ingress.InboundEvent {
  return {
    ...event,
    meta: {
      ...event.meta,
      ...(evidence === undefined ? {} : { authorityEvidence: evidence }),
      actor: legacyActorFields(event.meta?.actor),
    },
  };
}

export async function resolveIngressActor(
  event: Ingress.InboundEvent,
  queries: AuthorityProjectionQueryPort,
): Promise<Ingress.InboundEvent> {
  const externalId = externalActorId(event);
  if (!externalId) return unresolvedActor(event);

  const result = await queries.query({
    kind: "authority.actor_by_endpoint",
    surface: event.surface,
    externalId,
    ...(event.workspace === undefined ? {} : { workspace: event.workspace }),
  });
  if (result.kind !== "authority.actor_by_endpoint") {
    throw new TypeError("authority actor query returned the wrong projection kind");
  }
  if (result.identity === null || result.endpoint === null) return unresolvedActor(event, result);
  if (result.endpoint.actorId !== result.identity.id) {
    throw new TypeError("authority actor projection identity and endpoint do not match");
  }

  return {
    ...event,
    meta: {
      ...event.meta,
      authorityEvidence: result,
      actor: {
        id: result.endpoint.externalId,
        role: "user",
        actorId: result.identity.id,
        kind: result.identity.kind,
        trustTier: result.identity.trustTier,
        relationship: result.identity.relationship,
        endpointId: result.endpoint.id,
        endpoint: result.endpoint,
      },
    },
  };
}
