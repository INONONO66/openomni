import { expect, test } from "bun:test";
import { createActorRegistry } from "../../src";
import { useSqliteStores } from "../helpers/storage";

const stores = useSqliteStores("actor-metadata");
const registry = () => createActorRegistry(stores.catalog);

test("identity and endpoint JSON metadata survive reopening without shape loss", () => {
  const identity = registry().registerIdentity({
    id: "actor",
    kind: "human",
    trustTier: "observer",
    metadata: { nested: [1, null, { enabled: true }] },
  });
  const endpoint = registry().registerEndpoint({
    id: "endpoint",
    actorId: identity.id,
    channel: "discord",
    externalId: "user",
    metadata: { tags: ["one", "two"] },
  });
  stores.reopen();
  expect(registry().getIdentity(identity.id)).toEqual(identity);
  expect(registry().getEndpoint(endpoint.id)).toEqual(endpoint);
  expect(registry().resolveEndpoint("discord", "user")).toEqual({ identity, endpoint });
});

test("non-JSON metadata fails before identity or endpoint persistence", () => {
  expect(() =>
    registry().registerIdentity({
      id: "invalid",
      kind: "human",
      trustTier: "observer",
      metadata: { callback: () => "not JSON" },
    }),
  ).toThrow();
  expect(registry().getIdentity("invalid")).toBeUndefined();
  registry().registerIdentity({ id: "valid", kind: "human", trustTier: "observer" });
  expect(() =>
    registry().registerEndpoint({
      id: "invalid",
      actorId: "valid",
      channel: "discord",
      externalId: "user",
      metadata: { count: 1n },
    }),
  ).toThrow();
  expect(registry().getEndpoint("invalid")).toBeUndefined();
});
