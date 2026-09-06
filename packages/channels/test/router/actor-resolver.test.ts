import { describe, expect, test } from "bun:test";
import { resolveIngressActor } from "../../src/router/actor-resolver";
import { makeEvent, registerOwnerEndpoint, setupIngressActorResolverTest } from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

describe("internal ingress actor projection", () => {
  test("registered endpoint replaces claimed authority with canonical actor fields", () => {
    registerOwnerEndpoint("guild");
    const actor = resolveIngressActor(makeEvent("user-1", {
      id: "user-1", role: "manager", type: "system", trusted: true, isTrustedManager: true,
    })).meta?.actor;
    expect(actor).toMatchObject({
      role: "user", id: "user-1", actorId: "act_owner", kind: "human",
      trustTier: "owner", endpointId: "ep_discord_user_1",
    });
    for (const key of ["type", "trusted", "isTrustedManager"]) expect(actor).not.toHaveProperty(key);
  });

  test.each(["guild-a", undefined])("workspace %s cannot resolve a guild endpoint", (workspace) => {
    registerOwnerEndpoint(workspace);
    const actor = resolveIngressActor(makeEvent("user-1", {
      id: "user-1", role: "user", actorId: "spoofed", trustTier: "owner",
    })).meta?.actor;
    expect(actor).toEqual({ id: "user-1", role: "user" });
  });

  test("workspace match resolves the canonical endpoint", () => {
    registerOwnerEndpoint("guild");
    expect(resolveIngressActor(makeEvent("user-1")).meta?.actor).toMatchObject({
      actorId: "act_owner", endpointId: "ep_discord_user_1", trustTier: "owner",
    });
  });
});
