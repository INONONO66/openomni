import { afterEach, describe, expect, it } from "bun:test";
import type { Actor, Ingress } from "@openomni/protocol";
import { IngressEngine } from "../../src/ingress/engine";
import type { AuthorityProjectionQueryPort } from "../../src/ingress/actor-resolver";
import { IngressRoutingError } from "../../src/ingress/routing-execution";
import { resolveKernelRoute } from "../../src/ingress/routing-runtime";
import type { WaitKernelService } from "../../src/ingress/wait-correlation";

const refs = {
  sourceEventId: "authority-event-access",
  sourceOwnerSeq: 2,
  sourceLedgerSeq: 3,
  sourceOwnerHash: "c".repeat(64),
  asOfLedgerSeq: 3,
} as const;

const identity: Actor.Identity = {
  id: "actor-owner",
  kind: "human",
  trustTier: "owner",
  relationship: "owner",
};
const endpoint: Actor.Endpoint = {
  id: "endpoint-owner",
  actorId: identity.id,
  channel: "discord",
  externalId: "owner-external",
};
const ownerEvent = {
  id: "inbound-owner",
  surface: "discord",
  workspace: "workspace-owner",
  channel: "owner-dm",
  userId: endpoint.externalId,
  mode: "direct" as const,
  payload: "hello",
  agent: { model: { provider: "test", id: "fixture" } },
} satisfies Ingress.DirectEvent;

const noWait: WaitKernelService = {
  async correlate() {
    return { kind: "none", candidates: [] };
  },
  async revalidatePinned() {
    return { kind: "invalid", reason: "not used" };
  },
  async acceptResponse() {
    throw new Error("not used");
  },
  async settle() {
    throw new Error("not used");
  },
  async cancel() {
    return undefined;
  },
  async stageAmbiguity() {
    return undefined;
  },
  async markRouted() {
    return undefined;
  },
};

function authority(options: {
  identity?: Actor.Identity | null;
  endpoint?: Actor.Endpoint | null;
  grant?: Actor.ChannelGrant | null;
  blacklist?: Actor.BlacklistEntry | null;
}): AuthorityProjectionQueryPort {
  return {
    async query(request) {
      switch (request.kind) {
        case "authority.actor_by_endpoint":
          return {
            ...refs,
            kind: request.kind,
            endpointSourceRefs: options.endpoint === null ? null : refs,
            identitySourceRefs: options.identity === null ? null : refs,
            identity: options.identity === undefined ? identity : options.identity,
            endpoint: options.endpoint === undefined ? endpoint : options.endpoint,
          };
        case "authority.blacklist_match":
          return { ...refs, kind: request.kind, entry: options.blacklist ?? null };
        case "authority.channel_grant":
          return { ...refs, kind: request.kind, grant: options.grant ?? null };
        case "authority.worker_grant":
          return { ...refs, kind: request.kind, grant: null };
      }
    },
  };
}

function trustedGrant(defaultTier?: Actor.TrustTier): Actor.ChannelGrant {
  return {
    id: "grant-owner",
    surface: ownerEvent.surface,
    workspace: ownerEvent.workspace,
    channel: ownerEvent.channel,
    kind: "trusted_channel",
    ...(defaultTier === undefined ? {} : { defaultTier }),
    createdBy: "actor-owner",
  };
}

async function captureError(action: Promise<unknown>): Promise<Error | undefined> {
  try {
    await action;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  return undefined;
}

describe("native ingress authority routing", () => {
  afterEach(() => IngressEngine.reset());

  it.each([
    ["missing channel grant", {}, "channel_ceiling"],
    [
      "blocked channel",
      {
        grant: {
          id: "grant-blocked",
          surface: ownerEvent.surface,
          workspace: ownerEvent.workspace,
          channel: ownerEvent.channel,
          kind: "blocked_channel",
          createdBy: "actor-owner",
        } satisfies Actor.ChannelGrant,
      },
      "channel_ceiling",
    ],
    [
      "unknown actor without a channel default",
      { identity: null, endpoint: null, grant: trustedGrant() },
      "actor_identity",
    ],
  ] as const)("blocks %s before Resident work", async (_name, options, stage) => {
    let residentRuns = 0;
    IngressEngine.setResidentRuntime({
      async run() {
        residentRuns += 1;
        throw new Error("blocked input executed Resident work");
      },
    } as never);
    IngressEngine.setKernelPorts({
      authorityQueries: authority(options),
      waitQueries: noWait,
      waitTransitions: noWait,
      workerAttempts: {} as never,
    });

    const error = await captureError(IngressEngine.ingest(ownerEvent));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect((error as IngressRoutingError).decision).toMatchObject({ stage, outcome: "block" });
    expect(residentRuns).toBe(0);
  });

  it("routes a registered actor with authoritative actor and channel evidence", async () => {
    const queries = authority({ grant: trustedGrant() });
    const event = {
      ...ownerEvent,
      meta: {
        authorityEvidence: refs,
        actor: {
          actorId: identity.id,
          trustTier: identity.trustTier,
          endpointId: endpoint.id,
          endpoint,
        },
      },
      runtime: { durableSessionId: "session-authoritative" },
    };
    const resolution = await resolveKernelRoute(event, "trace-authoritative", {
      authorityQueries: queries,
      waits: noWait,
    });

    expect(resolution.decision).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      actorId: identity.id,
      trustTier: "owner",
      inboundTreatment: "full_access",
      sessionId: "session-authoritative",
    });
    expect(resolution.decision.factsUsed).toContain(`authority.source_event:${refs.sourceEventId}`);
    expect(resolution.event.meta).toMatchObject({
      channelGrantId: "grant-owner",
      channelGrantKind: "trusted_channel",
      inboundTreatment: "full_access",
      actor: { actorId: identity.id, trustTier: "owner" },
    });
  });

  it("applies the channel default tier without manufacturing a durable actor identity", async () => {
    const event = { ...ownerEvent, userId: "unknown-external", meta: {} };
    const resolution = await resolveKernelRoute(event, "trace-channel-default", {
      authorityQueries: authority({
        identity: null,
        endpoint: null,
        grant: trustedGrant("observer"),
      }),
      waits: noWait,
    });

    expect(resolution.decision).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "observer",
      inboundTreatment: "full_access",
    });
    expect(resolution.decision.actorId).toBeUndefined();
    expect(resolution.event.meta?.actor).toEqual({ role: "user", trustTier: "observer" });
  });

  it("normalizes broadcast access to evidence-only even when the projection asks for full access", async () => {
    const grant = {
      id: "grant-broadcast",
      surface: ownerEvent.surface,
      workspace: ownerEvent.workspace,
      channel: ownerEvent.channel,
      kind: "broadcast_channel",
      inboundTreatment: "full_access",
      defaultTier: "observer",
      createdBy: "actor-owner",
    } satisfies Actor.ChannelGrant;
    const resolution = await resolveKernelRoute({ ...ownerEvent, meta: {} }, "trace-broadcast", {
      authorityQueries: authority({ identity: null, endpoint: null, grant }),
      waits: noWait,
    });

    expect(resolution.decision).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "observer",
      inboundTreatment: "evidence_only",
    });
    expect(resolution.event.meta).toMatchObject({
      channelGrantKind: "broadcast_channel",
      inboundTreatment: "evidence_only",
    });
  });

  it("drops a blacklisted actor before channel and actor authority can create work", async () => {
    const resolution = await resolveKernelRoute(
      {
        ...ownerEvent,
        meta: {
          actor: { actorId: identity.id, trustTier: identity.trustTier, endpointId: endpoint.id },
        },
      },
      "trace-blacklisted",
      {
        authorityQueries: authority({
          grant: trustedGrant(),
          blacklist: {
            id: "blacklist-owner",
            kind: "actor",
            value: identity.id,
            createdBy: "security-owner",
            reason: "revoked",
          },
        }),
        waits: noWait,
      },
    );

    expect(resolution.decision).toMatchObject({
      stage: "blacklist",
      outcome: "drop",
      reason: "Inbound principal matched the blacklist",
    });
    expect(resolution.decision.sessionId).toBeUndefined();
    expect(resolution.decision.target).toBeUndefined();
  });
});
