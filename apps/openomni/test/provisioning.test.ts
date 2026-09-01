import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActorRegistry,
  ChannelInstanceStore,
  PersonStore,
  SecretStore,
  SqliteStorageAdapter,
  Storage,
  Vault,
} from "@openomni/ledger";
import type { Provisioning } from "@openomni/protocol";
import { declaredChannelProfile } from "../src/channels";
import type { OpenOmniConfig } from "../src/config";
import { materializePersons, selectChannelProfile, vaultCredentialReader } from "../src/provisioning/declared";
import { runProvisioningInit } from "../src/provisioning/init";
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
    memoryPath: "/tmp/unused-memory.md",
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
    expect(rows[0]?.id).toBe("telegram");
    const built = rows[0]?.build(() => Promise.resolve(null));
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
    const selection = selectChannelProfile(envConfig, {}, home);
    expect(selection.source).toBe("env");
    expect(selection.rows.map((row) => row.id)).toEqual(["telegram"]);
    expect(selection.statuses).toEqual([]);
  });

  test("§8.1 env ghost law: one disabled declaration shadows a live env token", () => {
    ChannelInstanceStore.put(instance({ enabled: false, credentialRef: undefined }));
    const selection = selectChannelProfile(envConfig, { OPENOMNI_VAULT_KEY: KEY_B64 }, home);
    expect(selection.source).toBe("declared");
    expect(selection.rows).toEqual([]);
    expect(selection.statuses).toEqual([
      { id: "channel:telegram:main", provider: "telegram", state: "disabled" },
    ]);
  });

  test("§8.4 locked vault: enabled declarations become vault_locked statuses, nothing mounts", () => {
    ChannelInstanceStore.put(instance({}));
    const selection = selectChannelProfile(envConfig, {}, home);
    expect(selection.source).toBe("declared");
    expect(selection.rows).toEqual([]);
    expect(selection.statuses[0]?.state).toBe("vault_locked");
    expect(selection.statuses[0]?.detail).toContain("no OPENOMNI_VAULT_KEY");
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

describe("openomni init (§6)", () => {
  let home: string;
  let dbPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "init-test-"));
    dbPath = join(home, "openomni.db");
  });

  afterEach(async () => {
    await rm(home, { recursive: true });
  });

  function runInit(): string[] {
    return runProvisioningInit({
      config: baseConfig({
        dbPath,
        channels: {
          telegram: { token: "tg-plain" },
          github: { secret: "gh-webhook-secret", token: "gh-token" },
        },
      }),
      env: {},
      home,
      now: () => NOW,
    });
  }

  function withStore<T>(fn: () => T): T {
    Storage.initialize({ dbPath: ":memory:" });
    Storage.configure(new SqliteStorageAdapter(dbPath));
    try {
      return fn();
    } finally {
      Storage.reset();
    }
  }

  test("mints the key file, seals env credentials, and declares instances", async () => {
    const lines = runInit();
    expect(lines[0]).toContain("minted vault key file");
    expect(lines).toHaveLength(3);
    expect(existsSync(vaultKeyPath(home))).toBe(true);

    const kekResolution = resolveKek({}, home);
    if (kekResolution.kind !== "ok") throw new Error("expected the minted key to resolve");
    withStore(() => {
      const declared = ChannelInstanceStore.list().map((row) => row.id);
      expect(declared.sort()).toEqual(["channel:github:main", "channel:telegram:main"]);
      const secret = SecretStore.get("secret:channel-telegram-main");
      if (secret === undefined) throw new Error("expected a sealed telegram credential");
      expect(Vault.open(secret, kekResolution.kek).revealText()).toBe('{"token":"tg-plain"}');
    });
    const fileBytes = await readFile(dbPath);
    expect(fileBytes.includes("tg-plain")).toBe(false);
    expect(fileBytes.includes("gh-webhook-secret")).toBe(false);
  });

  test("re-running init leaves existing declarations untouched", () => {
    runInit();
    const second = runInit();
    expect(second.filter((line) => line.includes("left untouched"))).toHaveLength(2);
    withStore(() => {
      expect(SecretStore.list()).toHaveLength(2);
    });
  });

  test("with no channel env config init reports nothing to import", () => {
    const lines = runProvisioningInit({
      config: baseConfig({ dbPath }),
      env: {},
      home,
      now: () => NOW,
    });
    expect(lines.at(-1)).toBe("no channel credentials in env config; nothing to import");
  });

  test("a corrupt env KEK is a fail-closed refusal, not a silent skip", () => {
    expect(() =>
      runProvisioningInit({
        config: baseConfig({ dbPath }),
        env: { OPENOMNI_VAULT_KEY: "%%%not-base64%%%" },
        home,
        now: () => NOW,
      }),
    ).toThrow(/vault is locked/);
  });
});
