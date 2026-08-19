import { describe, expect, it } from "bun:test";
import {
  getRouter,
  lastResolvedActor,
  makeEvent,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
} from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

describe("Ingress actor resolver", () => {
  it("adds canonical actor fields for registered endpoints", async () => {
    // Given
    registerOwnerEndpoint("guild");
    const router = getRouter();

    // When
    await router.ingest(
      makeEvent("user-1", {
        id: "user-1",
        role: "manager",
        type: "system",
        trusted: true,
        isTrustedManager: true,
      }),
    );
    const capturedActor = lastResolvedActor();

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

  it("carries the resolved actor on the delivered event", async () => {
    // Given
    registerOwnerEndpoint("guild");
    const router = getRouter();

    // When
    await router.ingest(makeEvent("user-1"));
    const projectedActor = lastResolvedActor();

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
    const router = getRouter();
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
    await router.ingest(event);
    const capturedActor = lastResolvedActor();

    // Then
    expect(capturedActor).toEqual({ role: "user", id: "user-1", trustTier: "owner" });
  });

  it("resolves actor identity when endpoint workspace matches", async () => {
    // Given
    registerOwnerEndpoint("guild");
    const router = getRouter();

    // When
    await router.ingest(makeEvent("user-1"));
    const capturedActor = lastResolvedActor();

    // Then
    expect(capturedActor).toMatchObject({
      actorId: "act_owner",
      endpointId: "ep_discord_user_1",
      trustTier: "owner",
    });
  });
});
