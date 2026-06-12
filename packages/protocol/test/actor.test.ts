import { describe, expect, test } from "bun:test";
import { Actor } from "../src/actor/index.js";

describe("Actor protocol contracts", () => {
  test("parses canonical identity and endpoint records", () => {
    // Given
    const identityInput = {
      id: "act_owner",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
      displayName: "Owner",
    };
    const endpointInput = {
      id: "ep_discord_user_1",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
    };

    // When
    const identity = Actor.Identity.parse(identityInput);
    const endpoint = Actor.Endpoint.parse(endpointInput);

    // Then
    expect(identity).toEqual(identityInput);
    expect(endpoint).toEqual(endpointInput);
  });

  test("rejects invalid actor vocabulary values", () => {
    // Given
    const invalidIdentity = {
      id: "act_bad",
      kind: "bot",
      trustTier: "root",
      relationship: "stranger",
    };

    // When
    const result = Actor.Identity.safeParse(invalidIdentity);

    // Then
    expect(result.success).toBe(false);
  });
});
