import { beforeEach, describe, expect, test } from "bun:test";
import { extractSurfaceKey, Ingress, Ledger } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore, Storage, SurfaceKey } from "@openomni/ledger";
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
  if (!IngressRoutingError.isInstance(error)) return undefined;
  const routed = error as IngressRoutingError;
  expect(routed.toObject()).toMatchObject({
    name: "IngressRoutingError",
    data: { code: routed.code },
  });
  return routed.code;
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

  test("redelivery against a pre-0025 legacy fact upcasts and re-delivers", async () => {
    // Given — capture the modern decision this inbound produces today.
    registerOwnerDm();
    createMappedOwnerSession();
    await makeRouter().ingest(ownerEvent);
    const modern = Storage.get().ledger?.headFact(streamId())?.data as Record<string, unknown>;

    // And — a fresh ledger whose recorded fact is the LEGACY shape: the same
    // decision plus the dead runId/pendingInteractionId fields that the
    // strict write schema rejects.
    resetRouterState();
    registerOwnerDm();
    SurfaceKey.claim(extractSurfaceKey(ownerEvent), modern.sessionId as string);
    const appended = Storage.get().ledger?.append(
      {
        streamId: streamId(),
        type: "route.decided",
        data: { ...modern, runId: "run-legacy", pendingInteractionId: "ask_legacy" },
      },
      0,
    );
    expect(appended).toMatchObject({ kind: "appended" });

    // When — the same inbound is redelivered after the upgrade.
    await makeRouter().ingest(ownerEvent);

    // Then — the recorded legacy fact upcasts, matches the fresh decision,
    // and the redelivery proceeds without a second fact.
    expect(deliveries).toHaveLength(1);
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

    let thrown: unknown;
    try {
      await router.ingest(ownerEvent);
    } catch (error) {
      thrown = error;
    }
    expect(thrownCode(thrown)).toBe("route_replay_divergent");
    // The refusal must not disclose perimeter-resolved authority values
    // (actor ids, trust tiers, treatments) to whoever triggered redelivery.
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    for (const secret of ["actor-owner", "actor-replacement", "owner", "manager", "evidence_only"]) {
      expect(message).not.toContain(secret);
    }
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
    const adapter = Storage.get();
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
      },
    });
    const router = makeRouter();

    await expect(router.ingest(ownerEvent)).rejects.toMatchObject({ code: "route_record_failed" });
    expect(deliveries).toHaveLength(0);
    expect(routingDecisions()).toHaveLength(0);
  });

  test("fails closed when the scoped ledger append port is absent", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const adapter = Storage.get();
    Storage.configure({
      ...adapter,
      transaction: adapter.transaction.bind(adapter),
      ledger: undefined,
    });

    await expect(makeRouter().ingest(ownerEvent)).rejects.toMatchObject({
      code: "route_record_failed",
    });
    expect(deliveries).toEqual([]);
    expect(routingDecisions()).toEqual([]);
  });

  test.each(["missing", "corrupt"] as const)(
    "fails closed when a route append conflicts with a %s recorded fact",
    async (recorded) => {
      registerOwnerDm();
      createMappedOwnerSession();
      const adapter = Storage.get();
      const ledger = adapter.ledger;
      if (ledger === undefined) throw new Error("ledger sub-adapter missing");
      Storage.configure({
        ...adapter,
        transaction: adapter.transaction.bind(adapter),
        ledger: {
          ...ledger,
          append: () => ({ kind: "cas_conflict", currentHead: 1 }),
          headFact: () =>
            recorded === "missing"
              ? undefined
              : ({
                  streamId: streamId(),
                  seq: 1,
                  type: Ingress.ROUTE_DECIDED_FACT_TYPE,
                  data: { invalid: true },
                } as never),
        },
      });

      await expect(makeRouter().ingest(ownerEvent)).rejects.toMatchObject({
        code: "route_record_failed",
      });
      expect(deliveries).toEqual([]);
      expect(routingDecisions()).toEqual([]);
    },
  );

  test("keeps the unconfigured messaging port fail-closed", () => {
    expect(() => makeRouter().messaging).toThrow();
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
