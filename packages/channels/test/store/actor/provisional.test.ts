import { describe, expect, test } from "bun:test";
import { createActorRegistry } from "../../../src/index.js";
import { useMemoryChannelStore } from "../helpers/sqlite";

const stores = useMemoryChannelStore();
const registry = () => createActorRegistry(stores.store);

const T0 = 1_000;

function mintOne(n: number, channel = "whatsapp", at = T0) {
  return registry().mintProvisional(
    {
      id: `contact:${channel}:ext-${n}`,
      kind: "unknown",
      trustTier: "observer",
      standing: "provisional",
      createdAt: at,
      updatedAt: at,
    },
    {
      id: `ep:${channel}:ext-${n}`,
      channel,
      externalId: `ext-${n}`,
    },
  );
}

describe("ActorRegistry provisional lifecycle (#P3)", () => {
  test("mintProvisional lands identity and endpoint together, standing provisional", () => {
    const minted = mintOne(1);
    expect(minted.identity).toMatchObject({ standing: "provisional", kind: "unknown" });
    expect(minted.endpoint).toMatchObject({ actorId: "contact:whatsapp:ext-1" });
    expect(registry().resolveEndpoint("whatsapp", "ext-1")?.identity.standing).toBe("provisional");
  });

  test("mintProvisional refuses a registered-standing mint", () => {
    expect(() =>
      registry().mintProvisional(
        { id: "actor-x", kind: "human", trustTier: "observer" },
        { id: "ep-x", channel: "whatsapp", externalId: "x" },
      ),
    ).toThrow(/requires standing "provisional"/);
  });

  test("countProvisionalMints counts only this channel's provisional rows in the window (§8.12)", () => {
    mintOne(1, "whatsapp", T0);
    mintOne(2, "whatsapp", T0 + 10);
    mintOne(3, "slack", T0 + 10);
    registry().registerIdentity({
      id: "actor-registered",
      kind: "human",
      trustTier: "collaborator",
      createdAt: T0 + 10,
    });
    registry().registerEndpoint({
      id: "ep-registered",
      actorId: "actor-registered",
      channel: "whatsapp",
      externalId: "reg-1",
      createdAt: T0 + 10,
    });

    expect(registry().countProvisionalMints("whatsapp", undefined, T0)).toBe(2);
    expect(registry().countProvisionalMints("whatsapp", undefined, T0 + 5)).toBe(1);
    expect(registry().countProvisionalMints("slack", undefined, T0)).toBe(1);
  });

  test("promote flips provisional to registered and is idempotent", () => {
    mintOne(1);
    const promoted = registry().promote("contact:whatsapp:ext-1");
    expect(promoted.standing).toBe("registered");
    expect(registry().promote("contact:whatsapp:ext-1").standing).toBe("registered");
    expect(registry().countProvisionalMints("whatsapp", undefined, T0)).toBe(0);
    expect(() => registry().promote("ghost")).toThrow(/identity not found/);
  });

  test("mergeEndpoint moves the endpoint onto the target identity (§8.4)", () => {
    mintOne(1);
    registry().registerIdentity({ id: "actor-known", kind: "human", trustTier: "collaborator" });

    const merged = registry().mergeEndpoint("ep:whatsapp:ext-1", "actor-known");

    expect(merged.actorId).toBe("actor-known");
    expect(registry().resolveEndpoint("whatsapp", "ext-1")?.identity.id).toBe("actor-known");
    expect(() => registry().mergeEndpoint("ghost", "actor-known")).toThrow(/endpoint not found/);
    expect(() => registry().mergeEndpoint("ep:whatsapp:ext-1", "ghost")).toThrow(
      /identity not found/,
    );
  });
});
