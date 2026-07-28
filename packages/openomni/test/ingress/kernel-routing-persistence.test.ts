import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BusPersistence, BusQuery } from "@openomni/session";
import { IngressEngine } from "../../src/ingress/engine";
import {
  createMappedOwnerSession,
  ownerEvent,
  registerOwnerDm,
  resetKernelRoutingState,
} from "./_kernel-routing-fixture";

describe("IngressEngine routing decision persistence", () => {
  beforeEach(resetKernelRoutingState);

  afterEach(() => {
    BusPersistence.stop();
  });

  test("persists the non-ephemeral decision through BusPersistence and BusQuery", async () => {
    // Given
    registerOwnerDm();
    const mappedSession = createMappedOwnerSession();
    BusPersistence.start();

    // When
    await IngressEngine.ingest(ownerEvent);
    await BusPersistence.flush();

    // Then
    const events = await BusQuery.listBySession(mappedSession.id, {
      type: "ingress.routing.decision",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: mappedSession.id,
      eventType: "ingress.routing.decision",
      visibility: "user_audit",
      data: {
        inboundId: ownerEvent.id,
        stage: "surface_default",
        outcome: "route",
        sessionId: mappedSession.id,
      },
    });
  });
});
