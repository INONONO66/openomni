import { beforeEach, describe, expect, test } from "bun:test";
import type { Gateway, Ingress } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore } from "@openomni/ledger";
import {
  deliveries,
  kernelRouter,
  ownerEvent,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

async function captureError(action: Promise<unknown>): Promise<Error | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}

function strangerEvent(id: string): Gateway.DeliveredEvent {
  const { meta: _meta, ...event } = ownerEvent;
  return { ...event, id, userId: `${id}-external` };
}

describe("GatewayRouter access routing", () => {
  beforeEach(resetRouterState);

  test("blocks a missing channel grant before delivery", async () => {
    // When
    const error = await captureError(kernelRouter().ingest(ownerEvent));

    // Then
    expect(error).toBeDefined();
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "channel_ceiling",
      outcome: "block",
    });
    expect(deliveries).toHaveLength(0);
  });

  test("blocks an unknown actor on a trusted channel without a default tier", async () => {
    // Given
    ChannelGrantStore.put({
      id: "grant-unknown",
      surface: ownerEvent.surface,
      workspace: ownerEvent.workspace,
      channel: ownerEvent.channel,
      kind: "trusted_channel",
      createdBy: "actor-owner",
    });

    // When
    const error = await captureError(kernelRouter().ingest(ownerEvent));

    // Then
    expect(error).toBeDefined();
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({ stage: "actor_identity", outcome: "block" });
  });

  test("does not promote a role-only legacy user to Owner", async () => {
    // Given
    ChannelGrantStore.put({
      id: "grant-role-only",
      surface: ownerEvent.surface,
      workspace: ownerEvent.workspace,
      channel: ownerEvent.channel,
      kind: "trusted_channel",
      createdBy: "actor-owner",
    });
    const { userId: _userId, ...roleOnlyEvent } = ownerEvent;

    // When
    const error = await captureError(kernelRouter().ingest(roleOnlyEvent));

    // Then
    expect(error).toBeDefined();
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({ stage: "actor_identity", outcome: "block" });
    expect(deliveries).toHaveLength(0);
  });

  test("materializes a default-tier stranger without registering an Actor endpoint", async () => {
    // Given
    const event = strangerEvent("inbound-stranger-default");
    ChannelGrantStore.put({
      id: "grant-stranger-default",
      surface: event.surface,
      workspace: event.workspace,
      channel: event.channel,
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "actor-owner",
    });

    // When
    await kernelRouter().ingest(event);

    // Then
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "owner",
    });
    // The routed verdict rides the delivered event (the projection audit that
    // used to observe it is brain-side, past the seam).
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.event.meta?.actor).toMatchObject({ role: "user", trustTier: "owner" });
    expect(deliveries[0]?.event.meta?.inboundTreatment).toBe("full_access");
    expect(deliveries[0]?.actorContext).toMatchObject({
      trustTier: "owner",
      inboundTreatment: "full_access",
      origin: { surface: event.surface, externalId: event.userId },
    });
    if (event.userId === undefined) throw new Error("shape");
    expect(
      ActorRegistry.resolveEndpoint(event.surface, event.userId, event.workspace),
    ).toBeUndefined();
  });

  test("uses normalized evidence-only treatment for a broadcast override", async () => {
    // Given
    const event = strangerEvent("inbound-broadcast-override");
    ChannelGrantStore.put({
      id: "grant-broadcast-override",
      surface: event.surface,
      workspace: event.workspace,
      channel: event.channel,
      kind: "broadcast_channel",
      inboundTreatment: "full_access",
      defaultTier: "observer",
      createdBy: "actor-owner",
    });

    // When
    const result: Ingress.IngressResult = await kernelRouter().ingest(event);

    // Then
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("resident response");
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "observer",
      inboundTreatment: "evidence_only",
    });
    expect(deliveries[0]?.event.meta?.actor).toMatchObject({
      role: "user",
      trustTier: "observer",
    });
    expect(deliveries[0]?.event.meta?.inboundTreatment).toBe("evidence_only");
    expect(deliveries).toHaveLength(1);
  });

  test("routes a broadcast channel as evidence-only", async () => {
    // Given
    ChannelGrantStore.put({
      id: "grant-broadcast",
      surface: ownerEvent.surface,
      workspace: ownerEvent.workspace,
      channel: ownerEvent.channel,
      kind: "broadcast_channel",
      defaultTier: "observer",
      createdBy: "actor-owner",
    });

    // When
    const result: Ingress.IngressResult = await kernelRouter().ingest(ownerEvent);

    // Then
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("resident response");
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "observer",
      inboundTreatment: "evidence_only",
    });
    expect(deliveries).toHaveLength(1);
  });

  test("blocks a blocked channel before delivery", async () => {
    // Given
    ChannelGrantStore.put({
      id: "grant-blocked",
      surface: ownerEvent.surface,
      workspace: ownerEvent.workspace,
      channel: ownerEvent.channel,
      kind: "blocked_channel",
      createdBy: "actor-owner",
    });

    // When
    const error = await captureError(kernelRouter().ingest(ownerEvent));

    // Then
    expect(error).toBeDefined();
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "channel_ceiling",
      outcome: "block",
      inboundTreatment: "drop",
    });
    expect(deliveries).toHaveLength(0);
  });
});
