import { expect, test } from "bun:test";
import { ActorRegistry } from "../../src";
import { useSqliteStorage } from "../helpers/storage";

const fixture = useSqliteStorage("actor-metadata");

test("identity and endpoint JSON metadata survive reopening without shape loss", () => {
  const identity = ActorRegistry.registerIdentity({
    id: "actor",
    kind: "human",
    trustTier: "observer",
    metadata: { nested: [1, null, { enabled: true }] },
  });
  const endpoint = ActorRegistry.registerEndpoint({
    id: "endpoint",
    actorId: identity.id,
    channel: "discord",
    externalId: "user",
    metadata: { tags: ["one", "two"] },
  });
  fixture.reopen();
  expect(ActorRegistry.getIdentity(identity.id)).toEqual(identity);
  expect(ActorRegistry.getEndpoint(endpoint.id)).toEqual(endpoint);
  expect(ActorRegistry.resolveEndpoint("discord", "user")).toEqual({ identity, endpoint });
});

test("non-JSON metadata fails before identity or endpoint persistence", () => {
  expect(() =>
    ActorRegistry.registerIdentity({
      id: "invalid",
      kind: "human",
      trustTier: "observer",
      metadata: { callback: () => "not JSON" },
    }),
  ).toThrow();
  expect(ActorRegistry.getIdentity("invalid")).toBeUndefined();
  ActorRegistry.registerIdentity({ id: "valid", kind: "human", trustTier: "observer" });
  expect(() =>
    ActorRegistry.registerEndpoint({
      id: "invalid",
      actorId: "valid",
      channel: "discord",
      externalId: "user",
      metadata: { count: 1n },
    }),
  ).toThrow();
  expect(ActorRegistry.getEndpoint("invalid")).toBeUndefined();
});
