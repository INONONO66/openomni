import { beforeEach, describe, expect, test } from "bun:test";
import { Ingress, Ledger } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { IngressRoutingError } from "../../src/router/routing-resolution";
import {
  createMappedOwnerSession,
  deliveries,
  makeRouter,
  ownerEvent,
  registerOwnerDm,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

const streamId = () => Ingress.routeStreamId(ownerEvent);

function thrownCode(error: unknown): string | undefined {
  return error instanceof IngressRoutingError ? error.code : undefined;
}

describe("GatewayRouter durable routing resolution", () => {
  beforeEach(resetRouterState);

  test("records a schema-valid channel-scoped decision before delivery", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const observed: unknown[] = [];
    const router = makeRouter({
      deliver: async () => {
        observed.push(Storage.get().ledger?.headFact(streamId()));
        return {
          mode: "direct",
          target: { kind: "resident" },
          sessionId: "owner-session",
          result: { output: "ok", finishReason: "stop" },
        };
      },
    });

    await router.ingest(ownerEvent);

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ streamId: streamId(), seq: 1, type: "route.decided" });
    expect(Ledger.RouteDecided.safeParse((observed[0] as { data: unknown }).data).success).toBe(
      true,
    );
  });

  test("records blocked decisions before returning the typed rejection", async () => {
    const router = makeRouter();
    await expect(router.ingest(ownerEvent)).rejects.toMatchObject({ code: "route_blocked" });
    expect(Storage.get().ledger?.headFact(streamId())).toMatchObject({
      seq: 1,
      type: "route.decided",
      data: { outcome: "block" },
    });
  });

  test("equivalent accepted redelivery re-delivers with exactly one route fact", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const router = makeRouter();

    await router.ingest(ownerEvent);
    await router.ingest(ownerEvent);

    expect(deliveries).toHaveLength(2);
    expect(Storage.get().ledger?.headFact(streamId())?.seq).toBe(1);
  });

  test("divergent redelivery refuses without action, fact, or projection", async () => {
    const router = makeRouter();
    await expect(router.ingest(ownerEvent)).rejects.toMatchObject({ code: "route_blocked" });
    registerOwnerDm();
    createMappedOwnerSession();
    const projections = routingDecisions().length;

    let thrown: unknown;
    try {
      await router.ingest(ownerEvent);
    } catch (error) {
      thrown = error;
    }

    expect(thrownCode(thrown)).toBe("route_replay_divergent");
    expect(deliveries).toHaveLength(0);
    expect(Storage.get().ledger?.headFact(streamId())?.seq).toBe(1);
    expect(routingDecisions()).toHaveLength(projections);
  });

  test.each([
    [
      "actorId",
      () => {
        ActorRegistry.registerIdentity({
          id: "actor-replacement",
          kind: "human",
          trustTier: "owner",
        });
        ActorRegistry.registerEndpoint({
          id: "endpoint-owner-dm",
          actorId: "actor-replacement",
          channel: ownerEvent.surface,
          externalId: ownerEvent.userId,
          workspace: ownerEvent.workspace,
        });
      },
    ],
    [
      "trustTier",
      () => {
        ActorRegistry.registerIdentity({
          id: "actor-owner",
          kind: "human",
          trustTier: "manager",
        });
      },
    ],
    [
      "inboundTreatment",
      () => {
        ChannelGrantStore.put({
          id: "grant-owner-dm",
          surface: ownerEvent.surface,
          workspace: ownerEvent.workspace,
          channel: ownerEvent.channel,
          kind: "trusted_channel",
          inboundTreatment: "evidence_only",
          createdBy: "actor-owner",
        });
      },
    ],
  ] as const)("redelivery with mutated %s authority refuses as divergent", async (_field, mutate) => {
    registerOwnerDm();
    createMappedOwnerSession();
    const router = makeRouter();
    await router.ingest(ownerEvent);
    const projections = routingDecisions().length;

    mutate();

    await expect(router.ingest(ownerEvent)).rejects.toMatchObject({
      code: "route_replay_divergent",
    });
    expect(deliveries).toHaveLength(1);
    expect(Storage.get().ledger?.headFact(streamId())?.seq).toBe(1);
    expect(routingDecisions()).toHaveLength(projections);
  });

  test("equivalent blocked redelivery repeats rejection without a second fact", async () => {
    const router = makeRouter();
    for (let delivery = 0; delivery < 2; delivery += 1) {
      await expect(router.ingest(ownerEvent)).rejects.toMatchObject({ code: "route_blocked" });
    }
    expect(Storage.get().ledger?.headFact(streamId())?.seq).toBe(1);
  });

  test("append failure returns route_record_failed without delivery or projection", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const adapter = Storage.getAdapter();
    Storage.configure({
      ...adapter,
      transaction: adapter.transaction.bind(adapter),
      ledger: {
        append: () => {
          throw new Error("ledger unavailable");
        },
        adoptStream: () => {
          throw new Error("ledger unavailable");
        },
        headFact: () => undefined,
        factsByType: () => [],
        verifyTail: () => [],
      },
    });
    const router = makeRouter();

    await expect(router.ingest(ownerEvent)).rejects.toMatchObject({ code: "route_record_failed" });
    expect(deliveries).toHaveLength(0);
    expect(routingDecisions()).toHaveLength(0);
  });

  test("forged telemetry cannot authorize; the fresh owner fact controls delivery", async () => {
    registerOwnerDm();
    const mapped = createMappedOwnerSession();
    Bus.publish(Ingress.Events.RoutingDecision, {
      inboundId: ownerEvent.id,
      surface: ownerEvent.surface,
      stage: "surface_default",
      outcome: "route",
      sessionId: "forged-session",
      traceId: ownerEvent.traceId,
      time: 1,
      reason: "forged telemetry",
      mode: "direct",
      factsUsed: [],
      target: "resident",
    });

    await makeRouter().ingest(ownerEvent);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sessionId).toBe(mapped.id);
    expect(Storage.get().ledger?.headFact(streamId())).toMatchObject({
      seq: 1,
      type: "route.decided",
      data: { sessionId: mapped.id },
    });
  });
});
