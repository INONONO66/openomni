import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActorRegistry,
  ChannelInstanceStore,
  PersonStore,
  SecretStore,
  Storage,
  Vault,
} from "@openomni/ledger";
import { Actor, type Provisioning } from "@openomni/protocol";
import { declaredChannelProfile, validateProviderCredential } from "../src/channels";
import type { OpenOmniConfig } from "../src/config";
import { MOUNTED_CHANNEL_DEFAULT_TIER } from "../src/gateway";
import { desiredChannels, materializePersons, vaultCredentialReader } from "../src/provisioning/declared";
import { ensureVaultKeyFile, resolveKek, vaultKeyPath } from "../src/provisioning/vault-key";

const NOW = 1_756_000_000_000;
const KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

function instance(overrides: Partial<Provisioning.ChannelInstance>): Provisioning.ChannelInstance {
  return {
    id: "channel:telegram:main",
    provider: "telegram",
    enabled: true,
    settings: {},
    credentialRef: "secret:channel-telegram-main",
    revision: 0,
    createdBy: "test",
    updatedAt: NOW,
    ...overrides,
  };
}

function baseConfig(overrides: Partial<OpenOmniConfig> = {}): OpenOmniConfig {
  return {
    dbPath: ":memory:",
    host: "127.0.0.1",
    wsPort: 0,
    model: { provider: "anthropic", id: "claude", apiKey: "unused" },
    ...overrides,
  };
}

describe("vault-key resolution", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "vault-key-test-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true });
  });

  test("OPENOMNI_VAULT_KEY wins over the key file", async () => {
    await writeFile(join(home, "unused"), "");
    const resolved = resolveKek({ OPENOMNI_VAULT_KEY: KEY_B64 }, home);
    expect(resolved.kind).toBe("ok");
  });

  test("a wrong-length env key is locked, never a partial KEK", () => {
    const short = Buffer.from(new Uint8Array(16)).toString("base64");
    const resolved = resolveKek({ OPENOMNI_VAULT_KEY: short }, home);
    expect(resolved.kind === "locked" && resolved.reason.includes("32 bytes")).toBe(true);
  });

  test("no env key and no key file is locked with the missing path named", () => {
    const resolved = resolveKek({}, home);
    expect(resolved.kind === "locked" && resolved.reason.includes(vaultKeyPath(home))).toBe(true);
  });

  test("ensureVaultKeyFile mints once at 0600 and the minted key resolves", () => {
    const first = ensureVaultKeyFile(home);
    expect(first.created).toBe(true);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    const second = ensureVaultKeyFile(home);
    expect(second.created).toBe(false);
    expect(resolveKek({}, home).kind).toBe("ok");
  });
});

describe("declared channel profile", () => {
  const kek = Vault.kekOf(new Uint8Array(32).fill(7));

  function readerFor(rows: Record<string, string>): Parameters<typeof declaredChannelProfile>[1] {
    return (ref) => {
      const plaintext = rows[ref];
      return plaintext === undefined
        ? { kind: "locked", reason: `no vault row for credentialRef ${ref}` }
        : { kind: "ok", plaintext: new TextEncoder().encode(plaintext) };
    };
  }

  test("a valid declaration mounts with the provider's trigger policy", () => {
    const { rows, statuses } = declaredChannelProfile(
      [instance({})],
      readerFor({ "secret:channel-telegram-main": '{"token":"tg-token"}' }),
    );
    expect(statuses).toEqual([
      { id: "channel:telegram:main", provider: "telegram", state: "ready" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.instanceId).toBe("channel:telegram:main");
    expect(rows[0]?.component.id).toBe("telegram");
    const built = rows[0]?.component.build(() => Promise.resolve(null));
    expect(built?.surface.config).toEqual({ triggers: [] });
    expect(built?.surface.id).toBe("telegram");
  });

  test("disabled, unknown-provider, and credential-less rows are statuses, not mounts", () => {
    const { rows, statuses } = declaredChannelProfile(
      [
        instance({ enabled: false }),
        instance({ id: "channel:smoke:main", provider: "smoke" }),
        instance({ id: "channel:discord:main", provider: "discord", credentialRef: undefined }),
      ],
      readerFor({}),
    );
    expect(rows).toEqual([]);
    expect(statuses.map((status) => status.state)).toEqual([
      "disabled",
      "unknown_provider",
      "missing_credential",
    ]);
  });

  test("locked vault and malformed payloads fail closed per row", () => {
    const { rows, statuses } = declaredChannelProfile(
      [
        instance({}),
        instance({
          id: "channel:discord:main",
          provider: "discord",
          credentialRef: "secret:channel-discord-main",
        }),
        instance({
          id: "channel:github:main",
          provider: "github",
          credentialRef: "secret:channel-github-main",
        }),
      ],
      readerFor({
        "secret:channel-discord-main": "not json",
        "secret:channel-github-main": '{"wrong":"shape"}',
      }),
    );
    expect(rows).toEqual([]);
    expect(statuses.map((status) => status.state)).toEqual([
      "vault_locked",
      "credential_invalid",
      "credential_invalid",
    ]);
  });

  test("vaultCredentialReader opens real store rows and reports lock reasons", () => {
    Storage.initialize({ dbPath: ":memory:" });
    try {
      const envelope = Vault.seal(new TextEncoder().encode('{"token":"tg"}'), kek);
      SecretStore.put({
        id: "secret:channel-telegram-main",
        ciphertext: envelope.ciphertext,
        wrappedDek: envelope.wrappedDek,
        kekId: envelope.kekId,
        purpose: "channel_credential",
        createdAt: NOW,
      });
      const reader = vaultCredentialReader({ kind: "ok", kek });
      const hit = reader("secret:channel-telegram-main");
      expect(hit.kind === "ok" && new TextDecoder().decode(hit.plaintext)).toBe('{"token":"tg"}');
      const miss = reader("secret:absent");
      expect(miss.kind === "locked" && miss.reason.includes("secret:absent")).toBe(true);
      const locked = vaultCredentialReader({ kind: "locked", reason: "no key" })("secret:any");
      expect(locked).toEqual({ kind: "locked", reason: "no key" });
      const wrongKek = vaultCredentialReader({
        kind: "ok",
        kek: Vault.kekOf(new Uint8Array(32).fill(8)),
      })("secret:channel-telegram-main");
      expect(wrongKek.kind === "locked" && wrongKek.reason.includes("kek")).toBe(true);
    } finally {
      Storage.reset();
    }
  });
});

describe("boot profile selection (§8.1, §8.4)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "select-profile-test-"));
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    Storage.reset();
    await rm(home, { recursive: true });
  });

  const envConfig = baseConfig({ channels: { telegram: { token: "env-token" } } });

  test("with no declarations the env path mounts exactly as before", () => {
    const selection = desiredChannels(envConfig, {}, home);
    expect(selection.source).toBe("env");
    expect(selection.rows.map((row) => row.component.id)).toEqual(["telegram"]);
    // Env rows carry a constant bounce key: only process restart re-reads env.
    expect(selection.rows[0]?.instanceId).toBe("env:telegram");
    expect(selection.rows[0]?.key).toBe("env");
    // #931: env config declares no tier, so the row mounts at the mount tier.
    expect(selection.rows[0]?.defaultTier).toBe(MOUNTED_CHANNEL_DEFAULT_TIER);
    expect(selection.statuses).toEqual([]);
  });

  // #931: the ChannelInstance grant block is the Owner's tier decision; a
  // declaration without one mounts at the mount tier, never owner.
  test("a declared row carries its grant tier, and an undeclared grant mounts at the mount tier", () => {
    const envelope = Vault.seal(
      new TextEncoder().encode('{"token":"tg"}'),
      Vault.kekOf(new Uint8Array(32).fill(7)),
    );
    SecretStore.put({
      id: "secret:channel-telegram-main",
      ciphertext: envelope.ciphertext,
      wrappedDek: envelope.wrappedDek,
      kekId: envelope.kekId,
      purpose: "channel_credential",
      createdAt: NOW,
    });

    // Every declared tier threads through exactly: a remap of any single tier
    // (e.g. observer -> owner) fails here rather than surviving on one literal.
    for (const tier of Actor.TrustTier.options) {
      ChannelInstanceStore.put(instance({ grant: { defaultTier: tier } }));
      const declaredTier = desiredChannels(envConfig, { OPENOMNI_VAULT_KEY: KEY_B64 }, home);
      expect(declaredTier.rows[0]?.defaultTier).toBe(tier);
    }

    ChannelInstanceStore.put(instance({ grant: { allowedSenders: ["tg:1"] } }));
    const noTier = desiredChannels(envConfig, { OPENOMNI_VAULT_KEY: KEY_B64 }, home);
    expect(noTier.rows[0]?.defaultTier).toBe(MOUNTED_CHANNEL_DEFAULT_TIER);
  });

  test("§8.1 env ghost law: one disabled declaration shadows a live env token", () => {
    ChannelInstanceStore.put(instance({ enabled: false, credentialRef: undefined }));
    const selection = desiredChannels(envConfig, { OPENOMNI_VAULT_KEY: KEY_B64 }, home);
    expect(selection.source).toBe("declared");
    expect(selection.rows).toEqual([]);
    expect(selection.statuses).toEqual([
      { id: "channel:telegram:main", provider: "telegram", state: "disabled" },
    ]);
  });

  test("§8.4 locked vault: enabled declarations become vault_locked statuses, nothing mounts", () => {
    ChannelInstanceStore.put(instance({}));
    const selection = desiredChannels(envConfig, {}, home);
    expect(selection.source).toBe("declared");
    expect(selection.rows).toEqual([]);
    expect(selection.statuses[0]?.state).toBe("vault_locked");
    expect(selection.statuses[0]?.detail).toContain("no OPENOMNI_VAULT_KEY");
  });

  test("§8.7 the declared bounce key folds revision with the secret's rotation epoch", () => {
    const envelope = Vault.seal(
      new TextEncoder().encode('{"token":"tg"}'),
      Vault.kekOf(new Uint8Array(32).fill(7)),
    );
    SecretStore.put({
      id: "secret:channel-telegram-main",
      ciphertext: envelope.ciphertext,
      wrappedDek: envelope.wrappedDek,
      kekId: envelope.kekId,
      purpose: "channel_credential",
      createdAt: NOW,
    });
    ChannelInstanceStore.put(instance({ revision: 4 }));
    const get = spyOn(SecretStore, "get");
    let before: ReturnType<typeof desiredChannels>;
    try {
      before = desiredChannels(envConfig, { OPENOMNI_VAULT_KEY: KEY_B64 }, home);
      expect(get.mock.calls).toEqual([["secret:channel-telegram-main"]]);
    } finally {
      get.mockRestore();
    }
    expect(before.rows[0]?.instanceId).toBe("channel:telegram:main");
    expect(before.rows[0]?.key).toBe(`4:${NOW}`);

    SecretStore.put({
      id: "secret:channel-telegram-main",
      ciphertext: envelope.ciphertext,
      wrappedDek: envelope.wrappedDek,
      kekId: envelope.kekId,
      purpose: "channel_credential",
      createdAt: NOW,
      rotatedAt: NOW + 50,
    });
    const after = desiredChannels(envConfig, { OPENOMNI_VAULT_KEY: KEY_B64 }, home);
    expect(after.rows[0]?.key).toBe(`4:${NOW + 50}`);
  });
});

describe("materializePersons", () => {
  beforeEach(() => {
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("Person manifests become identity and endpoint facts, idempotently", () => {
    PersonStore.put({
      id: "person:ino",
      displayName: "Ino",
      kind: "human",
      trustTier: "owner",
      endpoints: [
        { channel: "telegram", externalId: "12345" },
        { channel: "discord", externalId: "9876", workspace: "guild-1" },
      ],
      revision: 0,
      createdBy: "openomni-init",
      updatedAt: NOW,
    });
    materializePersons();
    materializePersons();
    const identity = ActorRegistry.getIdentity("person:ino");
    expect(identity?.trustTier).toBe("owner");
    expect(identity?.displayName).toBe("Ino");
    const resolved = ActorRegistry.resolveEndpoint("telegram", "12345");
    expect(resolved?.endpoint.actorId).toBe("person:ino");
    const discord = ActorRegistry.resolveEndpoint("discord", "9876", "guild-1");
    expect(discord?.endpoint.workspace).toBe("guild-1");
  });
});

describe("provider credential gate", () => {
  test("an unregistered provider is refused before any schema runs", () => {
    expect(validateProviderCredential("smoke", { token: "t" })).toBe("unknown provider smoke");
  });
});

describe("github declared row", () => {
  test("a github declaration mounts through the provider credential schema", () => {
    const { rows, statuses } = declaredChannelProfile(
      [
        {
          id: "channel:github:main",
          provider: "github",
          enabled: true,
          settings: {},
          credentialRef: "secret:channel-github-main",
          revision: 0,
          createdBy: "test",
          updatedAt: 1,
        },
      ],
      () => ({
        kind: "ok",
        plaintext: new TextEncoder().encode('{"secret":"hook-secret"}'),
      }),
    );
    expect(statuses).toEqual([{ id: "channel:github:main", provider: "github", state: "ready" }]);
    expect(rows[0]?.component.id).toBe("github");
  });

  test("a slack declaration mounts through the provider credential schema", () => {
    const { rows, statuses } = declaredChannelProfile(
      [
        {
          id: "channel:slack:main",
          provider: "slack",
          enabled: true,
          settings: {},
          credentialRef: "secret:channel-slack-main",
          revision: 0,
          createdBy: "test",
          updatedAt: 1,
        },
      ],
      () => ({
        kind: "ok",
        plaintext: new TextEncoder().encode('{"botToken":"xoxb-1","appToken":"xapp-1"}'),
      }),
    );
    expect(statuses).toEqual([{ id: "channel:slack:main", provider: "slack", state: "ready" }]);
    expect(rows[0]?.component.id).toBe("slack");
  });
});
