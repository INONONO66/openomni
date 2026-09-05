import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Provisioning } from "@openomni/protocol";
import {
  ChannelInstanceStore,
  PersonStore,
  SecretStore,
  SqliteStorageAdapter,
  Storage,
  Vault,
} from "../../src/index.js";

const NOW = 1_756_000_000_000;

function person(id: string, trustTier: Provisioning.Person["trustTier"]): Provisioning.Person {
  return {
    id,
    displayName: id,
    kind: "human",
    trustTier,
    endpoints: [{ channel: "telegram", externalId: "12345" }],
    revision: 0,
    createdBy: "test",
    updatedAt: NOW,
  };
}

function kekFixture(byte: number): Vault.Kek {
  return Vault.kekOf(new Uint8Array(32).fill(byte));
}

function secretRow(id: string, envelope: Vault.Envelope): Provisioning.Secret {
  return {
    id,
    ciphertext: envelope.ciphertext,
    wrappedDek: envelope.wrappedDek,
    kekId: envelope.kekId,
    purpose: "channel_credential",
    createdAt: NOW,
  };
}

describe("provisioning stores", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "provisioning-test-"));
    dbPath = join(tmpDir, "test.db");
    Storage.initialize({ dbPath: ":memory:" });
    Storage.configure(new SqliteStorageAdapter(dbPath));
  });

  afterEach(async () => {
    Storage.reset();
    await rm(tmpDir, { recursive: true });
  });

  test("Person roundtrips, lists, and removes", () => {
    const declared = PersonStore.put(person("person:alice", "collaborator"));
    expect(PersonStore.get("person:alice")).toEqual(declared);
    expect(PersonStore.list()).toEqual([declared]);
    expect(PersonStore.remove("person:alice")).toBe(true);
    expect(PersonStore.get("person:alice")).toBeUndefined();
    expect(PersonStore.remove("person:alice")).toBe(false);
  });

  test("sole-owner invariant: a second owner Person is a typed owner_exists refusal", () => {
    PersonStore.put(person("person:ino", "owner"));
    let caught: Provisioning.StoreError | undefined;
    try {
      PersonStore.put(person("person:mallory", "owner"));
    } catch (error) {
      if (Provisioning.StoreError.isInstance(error)) caught = error;
    }
    if (caught === undefined) throw new Error("expected a typed StoreError");
    expect(caught.data.code).toBe("owner_exists");
    expect(caught.data.id).toBe("person:ino");
    expect(PersonStore.get("person:mallory")).toBeUndefined();
  });

  test("the reigning owner Person may be re-declared and other tiers coexist", () => {
    PersonStore.put(person("person:ino", "owner"));
    const updated = PersonStore.put({ ...person("person:ino", "owner"), revision: 1 });
    expect(updated.revision).toBe(1);
    PersonStore.put(person("person:bob", "observer"));
    expect(PersonStore.list()).toHaveLength(2);
  });

  test("ChannelInstance roundtrips with settings and credentialRef intact", () => {
    const instance: Provisioning.ChannelInstance = {
      id: "channel:telegram:main",
      provider: "telegram",
      enabled: true,
      settings: { pollIntervalMs: 500 },
      credentialRef: "secret:channel-telegram-main",
      revision: 0,
      createdBy: "test",
      updatedAt: NOW,
    };
    ChannelInstanceStore.put(instance);
    expect(ChannelInstanceStore.get(instance.id)).toEqual(instance);
    expect(ChannelInstanceStore.list()).toEqual([instance]);
    expect(ChannelInstanceStore.remove(instance.id)).toBe(true);
    expect(ChannelInstanceStore.list()).toEqual([]);
  });

  test("Secret BLOB envelope roundtrips byte-exact through SQLite", () => {
    const kek = kekFixture(7);
    const envelope = Vault.seal(new TextEncoder().encode('{"token":"tg-token"}'), kek);
    const row = secretRow("secret:channel-telegram-main", envelope);
    SecretStore.put(row);
    const loaded = SecretStore.get(row.id);
    if (loaded === undefined) throw new Error("expected the secret row back");
    expect(loaded.ciphertext).toEqual(envelope.ciphertext);
    expect(loaded.wrappedDek).toEqual(envelope.wrappedDek);
    expect(loaded.kekId).toBe(kek.id);
    expect(Vault.open(loaded, kek).revealText()).toBe('{"token":"tg-token"}');
    expect(SecretStore.list()).toHaveLength(1);
    expect(SecretStore.remove(row.id)).toBe(true);
  });

  test("§8.2: the database file never contains credential plaintext", async () => {
    const plaintext = "hunter2-super-secret-token";
    const kek = kekFixture(9);
    SecretStore.put(
      secretRow("secret:leak-probe", Vault.seal(new TextEncoder().encode(plaintext), kek)),
    );
    const fileBytes = await readFile(dbPath);
    expect(fileBytes.includes(plaintext)).toBe(false);
  });

  test("a storage adapter without the provisioning seam fails closed with adapter_absent", () => {
    Storage.reset();
    Storage.configure({ transaction: (fn) => fn() });
    for (const attempt of [
      () => PersonStore.list(),
      () => ChannelInstanceStore.list(),
      () => SecretStore.list(),
    ]) {
      let caught: Provisioning.StoreError | undefined;
      try {
        attempt();
      } catch (error) {
        if (Provisioning.StoreError.isInstance(error)) caught = error;
      }
      expect(caught?.data.code).toBe("adapter_absent");
    }
  });
});

describe("Vault envelope crypto", () => {
  test("kekOf refuses non-32-byte keys with a typed vault_locked error", () => {
    let caught: Provisioning.VaultError | undefined;
    try {
      Vault.kekOf(new Uint8Array(16));
    } catch (error) {
      if (Provisioning.VaultError.isInstance(error)) caught = error;
    }
    expect(caught?.data.code).toBe("vault_locked");
  });

  test("kek ids are stable fingerprints of the key bytes", () => {
    expect(kekFixture(3).id).toBe(kekFixture(3).id);
    expect(kekFixture(3).id).not.toBe(kekFixture(4).id);
    expect(kekFixture(3).id.startsWith("kek:")).toBe(true);
  });

  test("seal produces ciphertext that shares no bytes with the plaintext", () => {
    const plaintext = "xoxb-plaintext-credential";
    const envelope = Vault.seal(new TextEncoder().encode(plaintext), kekFixture(1));
    expect(Buffer.from(envelope.ciphertext).includes(plaintext)).toBe(false);
  });

  test("open under the wrong KEK id is a typed kek_mismatch", () => {
    const envelope = Vault.seal(new TextEncoder().encode("value"), kekFixture(1));
    let caught: Provisioning.VaultError | undefined;
    try {
      Vault.open({ ...envelope, id: "secret:mismatch" }, kekFixture(2));
    } catch (error) {
      if (Provisioning.VaultError.isInstance(error)) caught = error;
    }
    expect(caught?.data.code).toBe("kek_mismatch");
    expect(caught?.data.secretId).toBe("secret:mismatch");
  });

  test("a tampered ciphertext fails authentication as a typed unopenable", () => {
    const kek = kekFixture(1);
    const envelope = Vault.seal(new TextEncoder().encode("value"), kek);
    const tampered = new Uint8Array(envelope.ciphertext);
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0xff;
    let caught: Provisioning.VaultError | undefined;
    try {
      Vault.open({ ...envelope, ciphertext: tampered }, kek);
    } catch (error) {
      if (Provisioning.VaultError.isInstance(error)) caught = error;
    }
    expect(caught?.data.code).toBe("unopenable");
  });

  test("a truncated packed blob is a typed unopenable, not a crash", () => {
    const kek = kekFixture(1);
    const envelope = Vault.seal(new TextEncoder().encode("value"), kek);
    let caught: Provisioning.VaultError | undefined;
    try {
      Vault.open({ ...envelope, wrappedDek: envelope.wrappedDek.slice(0, 8) }, kek);
    } catch (error) {
      if (Provisioning.VaultError.isInstance(error)) caught = error;
    }
    expect(caught?.data.code).toBe("unopenable");
  });

  test("§8.3: every accidental serialization of a revealed secret prints [redacted]", () => {
    const kek = kekFixture(5);
    const revealed = Vault.open(Vault.seal(new TextEncoder().encode("tg-token"), kek), kek);
    expect(String(revealed)).toBe("[redacted]");
    expect(`${revealed}`).toBe("[redacted]");
    expect(JSON.stringify({ secret: revealed })).toBe('{"secret":"[redacted]"}');
    expect(inspect(revealed)).toBe("[redacted]");
    expect(revealed.reveal()).toEqual(new TextEncoder().encode("tg-token"));
    expect(revealed.revealText()).toBe("tg-token");
  });
});
