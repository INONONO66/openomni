import { beforeEach, describe, expect, test } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore } from "@openomni/session";
import {
  flushBusObservers,
  kernelEngine,
  makeKernelRoutingEngine,
  observeRoutedFacts,
  ownerEvent,
  resetKernelRoutingState,
  residentExecutions,
  routingDecisions,
} from "./_kernel-routing-fixture";

async function captureError(action: Promise<unknown>): Promise<Error | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}

function strangerEvent(id: string): Ingress.DirectEvent {
  const { meta: _meta, ...event } = ownerEvent;
  return { ...event, id, userId: `${id}-external` };
}

describe("IngressEngine access routing", () => {
  beforeEach(resetKernelRoutingState);

  test("blocks a missing channel grant before Resident execution", async () => {
    // Given
    const observed = routingDecisions();

    // When
    let error: Error | undefined;
    try {
      error = await captureError(kernelEngine().ingest(ownerEvent));
    } finally {
      observed.unsubscribe();
    }

    // Then
    expect(error).toBeDefined();
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "channel_ceiling",
      outcome: "block",
    });
    expect(residentExecutions).toHaveLength(0);
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
    const observed = routingDecisions();

    // When
    let error: Error | undefined;
    try {
      error = await captureError(kernelEngine().ingest(ownerEvent));
    } finally {
      observed.unsubscribe();
    }

    // Then
    expect(error).toBeDefined();
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({ stage: "actor_identity", outcome: "block" });
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
    const observed = routingDecisions();

    // When
    let error: Error | undefined;
    try {
      error = await captureError(kernelEngine().ingest(roleOnlyEvent));
    } finally {
      observed.unsubscribe();
    }

    // Then
    expect(error).toBeDefined();
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({ stage: "actor_identity", outcome: "block" });
    expect(residentExecutions).toHaveLength(0);
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
    const captured: { actor?: unknown; treatment?: unknown } = {};
    const unobserveFacts = observeRoutedFacts(event.id, captured);
    const observed = routingDecisions();

    // When
    try {
      await kernelEngine().ingest(event);
      await flushBusObservers();
    } finally {
      observed.unsubscribe();
      unobserveFacts();
    }

    // Then
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "owner",
    });
    expect(captured.actor).toMatchObject({ role: "user", trustTier: "owner" });
    expect(captured.treatment).toBe("full_access");
    if (event.userId === undefined) throw new Error("shape");
    expect(
      ActorRegistry.resolveEndpoint(event.surface, event.userId, event.workspace),
    ).toBeUndefined();
    expect(residentExecutions).toHaveLength(1);
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
    const captured: { actor?: unknown; treatment?: unknown } = {};
    const unobserveFacts = observeRoutedFacts(event.id, captured);
    const observed = routingDecisions();

    // When
    let result: Ingress.IngressResult;
    try {
      result = await kernelEngine().ingest(event);
      await flushBusObservers();
    } finally {
      observed.unsubscribe();
      unobserveFacts();
    }

    // Then
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("resident response");
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "observer",
      inboundTreatment: "evidence_only",
    });
    expect(captured.actor).toMatchObject({ role: "user", trustTier: "observer" });
    expect(captured.treatment).toBe("evidence_only");
    expect(residentExecutions).toHaveLength(1);
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
    const observed = routingDecisions();

    // When
    let result: Ingress.IngressResult;
    try {
      result = await kernelEngine().ingest(ownerEvent);
    } finally {
      observed.unsubscribe();
    }

    // Then
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("resident response");
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "observer",
      inboundTreatment: "evidence_only",
    });
    expect(residentExecutions).toHaveLength(1);
  });

  test("blocks a blocked channel before Resident execution", async () => {
    // Given
    ChannelGrantStore.put({
      id: "grant-blocked",
      surface: ownerEvent.surface,
      workspace: ownerEvent.workspace,
      channel: ownerEvent.channel,
      kind: "blocked_channel",
      createdBy: "actor-owner",
    });
    const observed = routingDecisions();

    // When
    let error: Error | undefined;
    try {
      error = await captureError(kernelEngine().ingest(ownerEvent));
    } finally {
      observed.unsubscribe();
    }

    // Then
    expect(error).toBeDefined();
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "channel_ceiling",
      outcome: "block",
      inboundTreatment: "drop",
    });
    expect(residentExecutions).toHaveLength(0);
  });

  test("publishes one route decision and continues for internal Resident input", async () => {
    // Given
    makeKernelRoutingEngine({
      agentResolver: {
        resolve: async () => ({ model: { provider: "test", id: "test-model" } }),
      },
    });
    const observed = routingDecisions();

    // When
    let result: Ingress.IngressResult;
    try {
      result = await kernelEngine().ingestInternal({
        id: "inbound-cron",
        traceId: "trace-test",
        surface: "cron",
        mode: "internal",
        agentName: "resident",
        payload: "run scheduled review",
      });
    } finally {
      observed.unsubscribe();
    }

    // Then
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("resident response");
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      inboundId: "inbound-cron",
      stage: "surface_default",
      outcome: "route",
      actorId: "system:cron",
    });
  });
});
