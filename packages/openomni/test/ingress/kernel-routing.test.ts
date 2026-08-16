import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IngressEvent } from "@openomni/protocol";
import { BlacklistStore, ChannelGrantStore } from "@openomni/session";
import { Bus } from "@openomni/telemetry";

import { IngressEventProjector } from "../../src/ingress/event-projector";
import {
  createMappedOwnerSession,
  ownerEvent,
  registerOwnerDm,
  kernelEngine,
  resetKernelRoutingState,
  residentExecutions,
  routingDecisions,
} from "./_kernel-routing-fixture";

describe("IngressEngine kernel routing", () => {
  beforeEach(resetKernelRoutingState);

  test("reuses the mapped surface session for a registered Owner DM", async () => {
    // Given
    registerOwnerDm();
    const mappedSession = createMappedOwnerSession();

    // When
    const result = await kernelEngine().ingest(ownerEvent);

    // Then
    if (result.kind === "dropped") throw new Error("shape");
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
      await kernelEngine().ingest(ownerEvent);
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

  test("does not project or execute when routing decision publication fails", async () => {
    // Given
    registerOwnerDm();
    createMappedOwnerSession();
    const actualPublish = Bus.publish;
    const publish = spyOn(Bus, "publish").mockImplementation((event, data) => {
      if (event === IngressEvent.RoutingDecision) throw new Error("routing publish failed");
      actualPublish(event, data);
    });
    const project = spyOn(IngressEventProjector, "project");

    // When / Then
    try {
      await expect(kernelEngine().ingest(ownerEvent)).rejects.toThrow("routing publish failed");
      expect(project).not.toHaveBeenCalled();
      expect(residentExecutions).toEqual([]);
    } finally {
      publish.mockRestore();
      project.mockRestore();
    }
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
      await kernelEngine().ingest(ownerEvent);
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
