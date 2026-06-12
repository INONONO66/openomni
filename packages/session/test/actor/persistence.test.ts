import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorRegistry, SqliteStorageAdapter, Storage } from "../../src/index.js";

describe("ActorRegistry SQLite persistence", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "actor-registry-test-"));
    dbPath = join(tmpDir, "test.db");
    Storage.initialize({ dbPath: ":memory:" });
    Storage.configure(new SqliteStorageAdapter(dbPath));
  });

  afterEach(async () => {
    Storage.reset();
    await rm(tmpDir, { recursive: true });
  });

  test("resolves registered endpoints across storage re-init", () => {
    // Given
    ActorRegistry.registerIdentity({
      id: "act_owner",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
    });
    ActorRegistry.registerEndpoint({
      id: "ep_discord_user_1",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
    });

    // When
    Storage.configure(new SqliteStorageAdapter(dbPath));
    const resolved = ActorRegistry.resolveEndpoint("discord", "user-1");

    // Then
    expect(resolved?.identity.id).toBe("act_owner");
    expect(resolved?.identity.trustTier).toBe("owner");
    expect(resolved?.endpoint.id).toBe("ep_discord_user_1");
  });

  test("returns undefined for unregistered endpoints", () => {
    // Given
    ActorRegistry.registerIdentity({
      id: "act_owner",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
    });

    // When
    const resolved = ActorRegistry.resolveEndpoint("discord", "unknown-user");

    // Then
    expect(resolved).toBeUndefined();
  });

  test("preserves createdAt when re-registering an identity", () => {
    // Given
    const createdAt = 100;
    ActorRegistry.registerIdentity({
      id: "act_owner",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
      createdAt,
      updatedAt: createdAt,
    });

    // When
    const updated = ActorRegistry.registerIdentity({
      id: "act_owner",
      kind: "human",
      trustTier: "manager",
      relationship: "owner",
      createdAt,
      updatedAt: createdAt,
    });

    // Then
    expect(updated.createdAt).toBe(createdAt);
    expect(updated.updatedAt).toBeGreaterThan(createdAt);
    expect(ActorRegistry.getIdentity("act_owner")?.trustTier).toBe("manager");
  });

  test("rejects endpoints for unknown actor identities", () => {
    // When / Then
    expect(() =>
      ActorRegistry.registerEndpoint({
        id: "ep_missing_actor",
        actorId: "act_missing",
        channel: "discord",
        externalId: "user-1",
      }),
    ).toThrow("Actor identity not found: act_missing");
  });

  test("rejects duplicate endpoint addresses with different endpoint ids", () => {
    // Given
    ActorRegistry.registerIdentity({
      id: "act_owner",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
    });
    ActorRegistry.registerEndpoint({
      id: "ep_discord_user_1",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
    });

    // When / Then
    expect(() =>
      ActorRegistry.registerEndpoint({
        id: "ep_discord_user_1_duplicate",
        actorId: "act_owner",
        channel: "discord",
        externalId: "user-1",
      }),
    ).toThrow("Actor endpoint already registered for discord:user-1");
  });

  test("removing an identity removes its endpoints through SQLite cascade", () => {
    // Given
    ActorRegistry.registerIdentity({
      id: "act_owner",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
    });
    ActorRegistry.registerEndpoint({
      id: "ep_discord_user_1",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
    });

    // When
    ActorRegistry.removeIdentity("act_owner");

    // Then
    expect(ActorRegistry.getEndpoint("ep_discord_user_1")).toBeUndefined();
    expect(ActorRegistry.resolveEndpoint("discord", "user-1")).toBeUndefined();
  });
});
