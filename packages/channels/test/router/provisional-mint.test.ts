import { ledger } from "../helpers/ledger";
import { describe, expect, test } from "bun:test";

import { resolveIngressActor } from "../../src/router/actor-resolver";
import { makeEvent, setupIngressActorResolverTest } from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

function putMintGrant(
  max = 2,
  kind: "trusted_channel" | "broadcast_channel" = "trusted_channel",
): void {
  ledger().stores.channelGrants.put({
    id: "grant-mint",
    surface: "whatsapp",
    workspace: "guild",
    channel: "dev",
    kind,
    defaultTier: "observer",
    provisionalMint: { windowMs: 600_000, max },
    createdBy: "act_owner",
  });
}
function whatsappEvent(id: string) {
  return { ...makeEvent(id), surface: "whatsapp" };
}

describe("provisional contact mint", () => {
  test("opted-in trusted channel mints evidence, never authority", () => {
    putMintGrant();
    const resolved = resolveIngressActor(ledger().stores, whatsappEvent("stranger-1"), 1);
    expect(resolved.meta?.actor).toMatchObject({
      actorId: "contact:whatsapp:guild:stranger-1",
      kind: "unknown",
      trustTier: "observer",
      standing: "provisional",
      endpointId: "ep:whatsapp:guild:stranger-1",
    });
    expect(resolved.meta?.inboundTreatment).toBe("evidence_only");
    expect(
      ledger().stores.actors.resolveEndpoint("whatsapp", "stranger-1", "guild")?.identity.standing,
    ).toBe("provisional");
  });
  test("redelivery resolves the same contact without a second mint", () => {
    putMintGrant();
    resolveIngressActor(ledger().stores, whatsappEvent("stranger-1"), 1);
    expect(resolveIngressActor(ledger().stores, whatsappEvent("stranger-1"), 1).meta?.actor?.actorId).toBe(
      "contact:whatsapp:guild:stranger-1",
    );
    expect(ledger().stores.actors.countProvisionalMints("whatsapp", "guild", 0)).toBe(1);
  });
  test("no policy means no mint", () => {
    expect(resolveIngressActor(ledger().stores, makeEvent("stranger-2"), 1).meta?.actor).toEqual({
      role: "user",
      id: "stranger-2",
    });
    expect(ledger().stores.actors.countProvisionalMints("discord", "guild", 0)).toBe(0);
  });
  test("window bound leaves additional senders without a canonical actor", () => {
    putMintGrant(1);
    resolveIngressActor(ledger().stores, whatsappEvent("stranger-1"), 1);
    expect(resolveIngressActor(ledger().stores, whatsappEvent("stranger-2"), 1).meta?.actor?.actorId).toBeUndefined();
    expect(ledger().stores.actors.countProvisionalMints("whatsapp", "guild", 0)).toBe(1);
  });
  test("blacklisted channel cannot mint", () => {
    putMintGrant();
    ledger().stores.blacklist.put({ id: "blocked", kind: "channel", value: "whatsapp", createdBy: "owner" });
    resolveIngressActor(ledger().stores, whatsappEvent("stranger-1"), 1);
    expect(ledger().stores.actors.countProvisionalMints("whatsapp", "guild", 0)).toBe(0);
  });
  test("broadcast channel cannot mint", () => {
    putMintGrant(2, "broadcast_channel");
    resolveIngressActor(ledger().stores, whatsappEvent("stranger-1"), 1);
    expect(ledger().stores.actors.countProvisionalMints("whatsapp", "guild", 0)).toBe(0);
  });
});
