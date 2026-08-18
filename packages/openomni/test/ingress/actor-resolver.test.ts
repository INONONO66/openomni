import { describe, expect, it } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import {
  flushBusObservers,
  getIngressEngine,
  makeEvent,
  observeResolvedActor,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
  testState,
} from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

describe("Ingress actor resolver", () => {
  it("adds canonical actor fields for registered endpoints", async () => {
    // Given
    registerOwnerEndpoint("guild");
    let capturedActor: Ingress.Actor | undefined;
    const engine = getIngressEngine();
    const unobserve = observeResolvedActor("event-user-1", (actor) => {
      capturedActor = actor;
    });
    testState.responseQueue.push("ok");

    // When
    try {
      await engine.ingest(
        makeEvent("user-1", {
          id: "user-1",
          role: "manager",
          type: "system",
          trusted: true,
          isTrustedManager: true,
        }),
      );
      await flushBusObservers();
    } finally {
      unobserve();
    }

    // Then
    expect(capturedActor).toMatchObject({
      role: "user",
      id: "user-1",
      actorId: "act_owner",
      kind: "human",
      trustTier: "owner",
      endpointId: "ep_discord_user_1",
    });
    expect(capturedActor).not.toHaveProperty("type");
    expect(capturedActor).not.toHaveProperty("trusted");
    expect(capturedActor).not.toHaveProperty("isTrustedManager");
  });

  it("projects the resolved actor onto the ingress inbound audit", async () => {
    // Given
    registerOwnerEndpoint("guild");
    const engine = getIngressEngine();
    let projectedActor: Ingress.Actor | undefined;
    const unobserve = observeResolvedActor("event-user-1", (actor) => {
      projectedActor = actor;
    });
    testState.responseQueue.push("ok");

    try {
      // When
      await engine.ingest(makeEvent("user-1"));
      await flushBusObservers();
    } finally {
      unobserve();
    }

    // Then
    expect(projectedActor).toMatchObject({
      role: "user",
      id: "user-1",
      actorId: "act_owner",
      kind: "human",
      trustTier: "owner",
      endpointId: "ep_discord_user_1",
    });
  });

  it("strips canonical actor fields when endpoint workspace does not match", async () => {
    // Given
    registerOwnerEndpoint("guild-a");
    let capturedActor: Ingress.Actor | undefined;
    const engine = getIngressEngine();
    const unobserve = observeResolvedActor("event-user-1", (actor) => {
      capturedActor = actor;
    });
    testState.responseQueue.push("ok");
    const event = {
      ...makeEvent("user-1", {
        role: "user",
        id: "user-1",
        actorId: "act_spoofed",
        kind: "system",
        type: "system",
        trustTier: "owner",
        trusted: true,
        isTrustedManager: true,
      }),
      workspace: "guild-b",
    };

    // When
    try {
      await engine.ingest(event);
      await flushBusObservers();
    } finally {
      unobserve();
    }

    // Then
    expect(capturedActor).toEqual({ role: "user", id: "user-1", trustTier: "owner" });
  });

  it("resolves actor identity when endpoint workspace matches", async () => {
    // Given
    registerOwnerEndpoint("guild");
    let capturedActor: Ingress.Actor | undefined;
    const engine = getIngressEngine();
    const unobserve = observeResolvedActor("event-user-1", (actor) => {
      capturedActor = actor;
    });
    testState.responseQueue.push("ok");

    // When
    try {
      await engine.ingest(makeEvent("user-1"));
      await flushBusObservers();
    } finally {
      unobserve();
    }

    // Then
    expect(capturedActor).toMatchObject({
      actorId: "act_owner",
      endpointId: "ep_discord_user_1",
      trustTier: "owner",
    });
  });
});
