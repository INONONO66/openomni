import { describe, expect, it } from "bun:test";
import { Storage } from "@openomni/ledger";
import {
  getRouter,
  lastResolvedActor,
  makeEvent,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
} from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

describe("Ingress actor resolver sanitization", () => {
  it("keeps only legacy id and role for unregistered endpoint actor metadata", async () => {
    // Given
    const router = getRouter();

    // When
    await router.ingest(
      makeEvent("unknown-user", {
        role: "user",
        id: "unknown-user",
        kind: "human",
        sessionId: "sess-spoof",
        workerId: "worker-spoof",
        futureTrustField: true,
      }),
    );
    const capturedActor = lastResolvedActor();

    // Then
    expect(capturedActor).toEqual({
      role: "user",
      id: "unknown-user",
      trustTier: "owner",
    });
  });

  it("strips spoofed canonical actor fields from unregistered endpoints", async () => {
    // Given
    const router = getRouter();

    // When
    await router.ingest(
      makeEvent("unknown-user", {
        role: "user",
        id: "unknown-user",
        actorId: "act_spoofed",
        kind: "system",
        type: "system",
        trustTier: "observer",
        endpointId: "ep_spoofed",
        trusted: true,
        isTrustedManager: true,
      }),
    );
    const capturedActor = lastResolvedActor();

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
    const router = getRouter();
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
    await router.ingest(withoutUserId);
    const capturedActor = lastResolvedActor();

    // Then
    expect(capturedActor).toEqual({ role: "user", id: "user-1", trustTier: "owner" });
  });

  it("does not resolve same external id from a different surface", async () => {
    // Given
    registerOwnerEndpoint("guild");
    const router = getRouter();

    // When
    await router.ingest({ ...makeEvent("user-1"), surface: "telegram" });
    const capturedActor = lastResolvedActor();

    // Then
    expect(capturedActor).toEqual({ role: "user", id: "user-1", trustTier: "owner" });
  });

  it("keeps ingest working with storage adapters that do not implement actorRegistry", async () => {
    // Given
    const base = Storage.get();
    const { actorRegistry: _actorRegistry, ...legacyAdapter } = base;
    // Spreading a class instance loses prototype methods — rebind the
    // required transaction so only actorRegistry is absent.
    Storage.configure({ ...legacyAdapter, transaction: base.transaction.bind(base) });
    const router = getRouter();

    // When
    await router.ingest(
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
    const capturedActor = lastResolvedActor();

    // Then
    expect(capturedActor).toEqual({ role: "user", id: "user-1", trustTier: "owner" });
  });
});
