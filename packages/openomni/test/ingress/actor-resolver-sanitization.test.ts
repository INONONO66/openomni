import { describe, expect, it } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import {
  captureActorPolicy,
  getIngressEngine,
  makeEvent,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
  testState,
} from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

describe("Ingress actor resolver sanitization", () => {
  it("keeps only legacy id and role for unregistered endpoint actor metadata", async () => {
    // Given
    let capturedActor: Ingress.Actor | undefined;
    const engine = getIngressEngine(
      captureActorPolicy((actor) => {
        capturedActor = actor;
      }),
    );
    testState.responseQueue.push("ok");

    // When
    await engine.ingest(
      makeEvent("unknown-user", {
        role: "user",
        id: "unknown-user",
        kind: "human",
        sessionId: "sess-spoof",
        workerId: "worker-spoof",
        futureTrustField: true,
      }),
    );

    // Then
    expect(capturedActor).toEqual({
      role: "user",
      id: "unknown-user",
      trustTier: "owner",
    });
  });

  it("strips spoofed canonical actor fields from unregistered endpoints", async () => {
    // Given
    let capturedActor: Ingress.Actor | undefined;
    const engine = getIngressEngine(
      captureActorPolicy((actor) => {
        capturedActor = actor;
      }),
    );
    testState.responseQueue.push("ok");

    // When
    await engine.ingest(
      makeEvent("unknown-user", {
        role: "user",
        id: "unknown-user",
        actorId: "act_spoofed",
        kind: "system",
        type: "system",
        trustTier: "observer",
        relationship: "owner",
        endpointId: "ep_spoofed",
        trusted: true,
        isTrustedManager: true,
      }),
    );

    // Then
    expect(capturedActor).toEqual({
      role: "user",
      id: "unknown-user",
      trustTier: "owner",
    });
  });

  it("does not resolve actor identity from legacy actor id when userId is absent", async () => {
    // Given
    registerOwnerEndpoint("guild");
    let capturedActor: Ingress.Actor | undefined;
    const engine = getIngressEngine(
      captureActorPolicy((actor) => {
        capturedActor = actor;
      }),
    );
    testState.responseQueue.push("ok");
    const event = makeEvent("user-1", {
      role: "user",
      id: "user-1",
      actorId: "act_spoofed",
      kind: "system",
      type: "system",
      trustTier: "observer",
      trusted: true,
      isTrustedManager: true,
    });
    const { userId: _userId, ...withoutUserId } = event;

    // When
    await engine.ingest(withoutUserId);

    // Then
    expect(capturedActor).toEqual({ role: "user", id: "user-1", trustTier: "owner" });
  });

  it("does not resolve same external id from a different surface", async () => {
    // Given
    registerOwnerEndpoint("guild");
    let capturedActor: Ingress.Actor | undefined;
    const engine = getIngressEngine(
      captureActorPolicy((actor) => {
        capturedActor = actor;
      }),
    );
    testState.responseQueue.push("ok");

    // When
    await engine.ingest({ ...makeEvent("user-1"), surface: "telegram" });

    // Then
    expect(capturedActor).toEqual({ role: "user", id: "user-1", trustTier: "owner" });
  });

  it("keeps ingest working with storage adapters that do not implement actorRegistry", async () => {
    // Given
    const { actorRegistry: _actorRegistry, ...legacyAdapter } = Storage.get();
    Storage.configure(legacyAdapter);
    let capturedActor: Ingress.Actor | undefined;
    const engine = getIngressEngine(
      captureActorPolicy((actor) => {
        capturedActor = actor;
      }),
    );
    testState.responseQueue.push("ok");

    // When
    await engine.ingest(
      makeEvent("user-1", {
        role: "user",
        id: "user-1",
        actorId: "act_spoofed",
        kind: "system",
        type: "system",
        trustTier: "observer",
        trusted: true,
        isTrustedManager: true,
      }),
    );

    // Then
    expect(capturedActor).toEqual({ role: "user", id: "user-1", trustTier: "owner" });
  });
});
