import { describe, expect, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { resolveIngressActor } from "../../src/router/actor-resolver";
import { makeEvent, registerOwnerEndpoint, setupIngressActorResolverTest } from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

const spoof = {
  role: "user", id: "user-1", actorId: "spoofed", kind: "system", type: "system",
  trustTier: "owner", endpointId: "spoofed-endpoint", trusted: true,
  isTrustedManager: true, sessionId: "spoofed-session", workerId: "spoofed-worker", futureTrustField: true,
} as const;

describe("internal actor projection sanitization", () => {
  test("unregistered endpoints cannot supply canonical authority", () => {
    expect(resolveIngressActor(makeEvent("user-1", spoof)).meta?.actor).toEqual({ role: "user", id: "user-1" });
  });

  test("legacy actor id is not an authenticated external id", () => {
    registerOwnerEndpoint("guild");
    const { userId: _userId, ...event } = makeEvent("user-1", spoof);
    expect(resolveIngressActor(event).meta?.actor).toEqual({ role: "user", id: "user-1" });
  });

  test("same external id on another surface has no canonical identity", () => {
    registerOwnerEndpoint("guild");
    expect(resolveIngressActor({ ...makeEvent("user-1", spoof), surface: "telegram" }).meta?.actor)
      .toEqual({ role: "user", id: "user-1" });
  });

  test("missing registry cannot preserve claimed authority", () => {
    const base = Storage.get();
    const { actorRegistry: _registry, ...adapter } = base;
    Storage.configure({ ...adapter, transaction: base.transaction.bind(base) });
    expect(resolveIngressActor(makeEvent("user-1", spoof)).meta?.actor).toEqual({ role: "user", id: "user-1" });
  });
});
