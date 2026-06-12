import { describe, expect, test } from "bun:test";
import { Actor } from "../src/index.js";

describe("Actor.ChannelGrant", () => {
  test("parses trusted, broadcast, and blocked grants", () => {
    for (const kind of ["trusted_channel", "broadcast_channel", "blocked_channel"] as const) {
      expect(
        Actor.ChannelGrant.parse({
          id: `grant-${kind}`,
          surface: "discord",
          kind,
          createdBy: "act_owner",
        }).kind,
      ).toBe(kind);
    }
  });

  test("accepts default tier and explicit inbound treatment", () => {
    const grant = Actor.ChannelGrant.parse({
      id: "grant-public",
      surface: "discord",
      workspace: "guild",
      channel: "design",
      kind: "broadcast_channel",
      defaultTier: "observer",
      inboundTreatment: "evidence_only",
      createdBy: "act_owner",
    });

    expect(grant.defaultTier).toBe("observer");
    expect(grant.inboundTreatment).toBe("evidence_only");
  });

  test("rejects missing creator audit field", () => {
    let failed = false;
    try {
      Actor.ChannelGrant.parse({
        id: "grant-missing-creator",
        surface: "discord",
        kind: "trusted_channel",
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
  });
});
