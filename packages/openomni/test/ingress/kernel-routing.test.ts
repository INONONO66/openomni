import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IngressEvent } from "@openomni/protocol";
import { BlacklistStore, ChannelGrantStore } from "@openomni/session";
import { IngressEngine } from "../../src/ingress/engine";
import {
  createMappedOwnerSession,
  ownerEvent,
  registerOwnerDm,
  resetKernelRoutingState,
  routingDecisions,
} from "./_kernel-routing-fixture";

describe("IngressEngine kernel routing", () => {
  beforeEach(resetKernelRoutingState);

  test("reuses the mapped surface session for a registered Owner DM", async () => {
    // Given
    registerOwnerDm();
    const mappedSession = createMappedOwnerSession();

    // When
    const result = await IngressEngine.ingest(ownerEvent);

    // Then
    expect(result.sessionId).toBe(mappedSession.id);
    expect(result.result.output).toBe("resident response");
  });

  test("publishes exactly one route decision for a registered Owner DM", async () => {
    // Given
    registerOwnerDm();
    const mappedSession = createMappedOwnerSession();
    const observed = routingDecisions();

    // When
    try {
      await IngressEngine.ingest(ownerEvent);
    } finally {
      observed.unsubscribe();
    }

    // Then
    expect(observed.decisions).toHaveLength(1);
    expect(IngressEvent.RoutingDecision.schema.parse(observed.decisions[0])).toMatchObject({
      inboundId: ownerEvent.id,
      stage: "surface_default",
      outcome: "route",
      sessionId: mappedSession.id,
      actorId: "actor-owner",
      trustTier: "owner",
      inboundTreatment: "full_access",
    });
  });

  test("reads blacklist and channel facts once for one canonical inbound", async () => {
    // Given
    registerOwnerDm();
    createMappedOwnerSession();
    const blacklistRead = spyOn(BlacklistStore, "match");
    const channelRead = spyOn(ChannelGrantStore, "resolve");
    let blacklistReads = 0;
    let channelReads = 0;

    // When
    try {
      await IngressEngine.ingest(ownerEvent);
      blacklistReads = blacklistRead.mock.calls.length;
      channelReads = channelRead.mock.calls.length;
    } finally {
      blacklistRead.mockRestore();
      channelRead.mockRestore();
    }

    // Then
    expect(blacklistReads).toBe(1);
    expect(channelReads).toBe(1);
  });
});
