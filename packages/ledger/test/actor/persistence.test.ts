import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
    });
    ActorRegistry.registerEndpoint({
      id: "ep_discord_user_1",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild",
    });

    // When
    Storage.configure(new SqliteStorageAdapter(dbPath));
    const resolved = ActorRegistry.resolveEndpoint("discord", "user-1", "guild");

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
      createdAt,
      updatedAt: createdAt,
    });

    // When
    const updated = ActorRegistry.registerIdentity({
      id: "act_owner",
      kind: "human",
      trustTier: "manager",
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
    });
    ActorRegistry.registerEndpoint({
      id: "ep_discord_user_1",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild",
    });

    // When / Then
    expect(() =>
      ActorRegistry.registerEndpoint({
        id: "ep_discord_user_1_duplicate",
        actorId: "act_owner",
        channel: "discord",
        externalId: "user-1",
        workspace: "guild",
      }),
    ).toThrow("Actor endpoint already registered for discord:guild:user-1");
  });

  test("allows the same endpoint address in different workspaces", () => {
    // Given
    ActorRegistry.registerIdentity({
      id: "act_owner",
      kind: "human",
      trustTier: "owner",
    });
    ActorRegistry.registerIdentity({
      id: "act_collaborator",
      kind: "human",
      trustTier: "collaborator",
    });
    ActorRegistry.registerEndpoint({
      id: "ep_discord_user_1_guild_a",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild-a",
    });

    // When
    ActorRegistry.registerEndpoint({
      id: "ep_discord_user_1_guild_b",
      actorId: "act_collaborator",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild-b",
    });

    // Then
    expect(ActorRegistry.resolveEndpoint("discord", "user-1", "guild-a")?.identity.id).toBe(
      "act_owner",
    );
    expect(ActorRegistry.resolveEndpoint("discord", "user-1", "guild-b")?.identity.id).toBe(
      "act_collaborator",
    );
    expect(ActorRegistry.resolveEndpoint("discord", "user-1", "guild-c")).toBeUndefined();
  });

  test("an old-format row whose data blob carries relationship parses and round-trips (#498 A1)", () => {
    // Given — a row persisted BEFORE the relationship removal: migration 0018
    // dropped the column, but the JSON blob keeps the retired key forever.
    const db = new Database(dbPath);
    db.query(
      `INSERT INTO actor_identity (id, data, kind, trust_tier, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "act_legacy",
      JSON.stringify({
        id: "act_legacy",
        kind: "human",
        trustTier: "owner",
        relationship: "owner",
        createdAt: 100,
        updatedAt: 100,
      }),
      "human",
      "owner",
      100,
      100,
    );
    db.close();
    Storage.configure(new SqliteStorageAdapter(dbPath));

    // When — read the legacy blob, then write it back through the registry.
    const identity = ActorRegistry.getIdentity("act_legacy");
    if (!identity) throw new Error("legacy identity not found");
    const roundTripped = ActorRegistry.registerIdentity({ ...identity, trustTier: "manager" });

    // Then — the retired key is stripped on read and stays gone after re-write.
    expect("relationship" in identity).toBe(false);
    expect(identity.trustTier).toBe("owner");
    expect(identity.createdAt).toBe(100);
    expect("relationship" in roundTripped).toBe(false);
    expect(ActorRegistry.getIdentity("act_legacy")?.trustTier).toBe("manager");
  });

  test("filters endpoint lists by actor and workspace", () => {
    // Given — two actors, endpoints across two workspaces.
    ActorRegistry.registerIdentity({ id: "act_owner", kind: "human", trustTier: "owner" });
    ActorRegistry.registerIdentity({
      id: "act_collaborator",
      kind: "human",
      trustTier: "collaborator",
    });
    ActorRegistry.registerEndpoint({
      id: "ep_owner_a",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild-a",
    });
    ActorRegistry.registerEndpoint({
      id: "ep_owner_b",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild-b",
    });
    ActorRegistry.registerEndpoint({
      id: "ep_collab_a",
      actorId: "act_collaborator",
      channel: "discord",
      externalId: "user-2",
      workspace: "guild-a",
    });

    // Then — every filter branch of the SQLite adapter returns the exact set
    // (ids sorted: the adapter orders by insertion timestamp, which is not a
    // stable assertion surface across same-millisecond registrations).
    const ids = (endpoints: readonly { id: string }[]) =>
      endpoints.map((endpoint) => endpoint.id).sort();
    expect(ids(ActorRegistry.listEndpoints())).toEqual(["ep_collab_a", "ep_owner_a", "ep_owner_b"]);
    expect(ids(ActorRegistry.listEndpoints("act_owner"))).toEqual(["ep_owner_a", "ep_owner_b"]);
    expect(ids(ActorRegistry.listEndpoints(undefined, "guild-a"))).toEqual([
      "ep_collab_a",
      "ep_owner_a",
    ]);
    expect(ids(ActorRegistry.listEndpoints("act_owner", "guild-b"))).toEqual(["ep_owner_b"]);
  });

  test("removing an identity removes its endpoints through SQLite cascade", () => {
    // Given
    ActorRegistry.registerIdentity({
      id: "act_owner",
      kind: "human",
      trustTier: "owner",
    });
    ActorRegistry.registerEndpoint({
      id: "ep_discord_user_1",
      actorId: "act_owner",
      channel: "discord",
      externalId: "user-1",
      workspace: "guild",
    });

    // When
    ActorRegistry.removeIdentity("act_owner");

    // Then
    expect(ActorRegistry.getEndpoint("ep_discord_user_1")).toBeUndefined();
    expect(ActorRegistry.resolveEndpoint("discord", "user-1", "guild")).toBeUndefined();
  });
});
