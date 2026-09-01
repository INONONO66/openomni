import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Actor } from "@openomni/protocol";
import { ActorRegistry, Storage } from "../../src/index";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

const T0 = 1_000;

function mintOne(n: number, channel = "whatsapp", at = T0): Actor.ResolvedEndpoint {
  return ActorRegistry.mintProvisional(
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
    expect(ActorRegistry.resolveEndpoint("whatsapp", "ext-1")?.identity.standing).toBe(
      "provisional",
    );
  });

  test("mintProvisional refuses a registered-standing mint", () => {
    expect(() =>
      ActorRegistry.mintProvisional(
        { id: "actor-x", kind: "human", trustTier: "observer" },
        { id: "ep-x", channel: "whatsapp", externalId: "x" },
      ),
    ).toThrow(/requires standing "provisional"/);
  });

  test("countProvisionalMints counts only this channel's provisional rows in the window (§8.12)", () => {
    mintOne(1, "whatsapp", T0);
    mintOne(2, "whatsapp", T0 + 10);
    mintOne(3, "slack", T0 + 10);
    ActorRegistry.registerIdentity({
      id: "actor-registered",
      kind: "human",
      trustTier: "collaborator",
      createdAt: T0 + 10,
    });
    ActorRegistry.registerEndpoint({
      id: "ep-registered",
      actorId: "actor-registered",
      channel: "whatsapp",
      externalId: "reg-1",
      createdAt: T0 + 10,
    });

    expect(ActorRegistry.countProvisionalMints("whatsapp", undefined, T0)).toBe(2);
    expect(ActorRegistry.countProvisionalMints("whatsapp", undefined, T0 + 5)).toBe(1);
    expect(ActorRegistry.countProvisionalMints("slack", undefined, T0)).toBe(1);
  });

  test("promote flips provisional to registered and is idempotent", () => {
    mintOne(1);
    const promoted = ActorRegistry.promote("contact:whatsapp:ext-1");
    expect(promoted.standing).toBe("registered");
    expect(ActorRegistry.promote("contact:whatsapp:ext-1").standing).toBe("registered");
    expect(ActorRegistry.countProvisionalMints("whatsapp", undefined, T0)).toBe(0);
    expect(() => ActorRegistry.promote("ghost")).toThrow(/identity not found/);
  });

  test("mergeEndpoint moves the endpoint onto the target identity (§8.4)", () => {
    mintOne(1);
    ActorRegistry.registerIdentity({ id: "actor-known", kind: "human", trustTier: "collaborator" });

    const merged = ActorRegistry.mergeEndpoint("ep:whatsapp:ext-1", "actor-known");

    expect(merged.actorId).toBe("actor-known");
    expect(ActorRegistry.resolveEndpoint("whatsapp", "ext-1")?.identity.id).toBe("actor-known");
    expect(() => ActorRegistry.mergeEndpoint("ghost", "actor-known")).toThrow(/endpoint not found/);
    expect(() => ActorRegistry.mergeEndpoint("ep:whatsapp:ext-1", "ghost")).toThrow(
      /identity not found/,
    );
  });
});
