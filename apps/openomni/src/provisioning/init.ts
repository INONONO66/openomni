import { ChannelInstanceStore, SecretStore, Storage, Vault, initialize } from "@openomni/ledger";
import type { Provisioning } from "@openomni/protocol";
import type { OpenOmniConfig } from "../config";
import { ensureVaultKeyFile, resolveKek } from "./vault-key";

/**
 * `openomni init` (docs/provisioning-and-providers.md §6): the one-time
 * migration from env-file channel config to the provisioning store. Mints
 * the vault key file when no KEK exists yet, then imports each configured
 * channel as a sealed Secret row plus a ChannelInstance declaration.
 * Idempotent: an existing declaration is reported and left untouched, so
 * re-running init never re-seals or overwrites Owner edits. Person import
 * arrives with the runtime-administration tools (`person_declare`).
 */

const CREATED_BY = "openomni-init";

interface ChannelImport {
  readonly provider: "telegram" | "discord" | "github";
  readonly credential: Record<string, string>;
}

function configuredImports(config: OpenOmniConfig): ChannelImport[] {
  const imports: ChannelImport[] = [];
  const telegram = config.channels?.telegram;
  if (telegram !== undefined) {
    imports.push({ provider: "telegram", credential: { token: telegram.token } });
  }
  const discord = config.channels?.discord;
  if (discord !== undefined) {
    imports.push({ provider: "discord", credential: { token: discord.token } });
  }
  const github = config.channels?.github;
  if (github !== undefined) {
    imports.push({
      provider: "github",
      credential: {
        secret: github.secret,
        ...(github.token === undefined ? {} : { token: github.token }),
        ...(github.botUsername === undefined ? {} : { botUsername: github.botUsername }),
      },
    });
  }
  return imports;
}

function importChannel(
  entry: ChannelImport,
  kek: Vault.Kek,
  now: number,
  lines: string[],
): void {
  const instanceId = `channel:${entry.provider}:main`;
  if (ChannelInstanceStore.get(instanceId) !== undefined) {
    lines.push(`${instanceId}: already declared, left untouched`);
    return;
  }
  const secretId = `secret:channel-${entry.provider}-main`;
  const plaintext = new TextEncoder().encode(JSON.stringify(entry.credential));
  const envelope = Vault.seal(plaintext, kek);
  const secret: Provisioning.Secret = {
    id: secretId,
    ciphertext: envelope.ciphertext,
    wrappedDek: envelope.wrappedDek,
    kekId: envelope.kekId,
    purpose: "channel_credential",
    createdAt: now,
  };
  SecretStore.put(secret);
  ChannelInstanceStore.put({
    id: instanceId,
    provider: entry.provider,
    enabled: true,
    settings: {},
    credentialRef: secretId,
    revision: 0,
    createdBy: CREATED_BY,
    updatedAt: now,
  });
  lines.push(`${instanceId}: imported from env (credential sealed as ${secretId})`);
}

export function runProvisioningInit(deps: {
  readonly config: OpenOmniConfig;
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  readonly now: () => number;
}): string[] {
  const lines: string[] = [];
  if (deps.env.OPENOMNI_VAULT_KEY === undefined) {
    const keyFile = ensureVaultKeyFile(deps.home);
    lines.push(
      keyFile.created
        ? `minted vault key file at ${keyFile.path} (0600)`
        : `vault key file already present at ${keyFile.path}`,
    );
  }
  const resolution = resolveKek(deps.env, deps.home);
  if (resolution.kind === "locked") {
    // Fail closed: importing credentials without a working KEK is impossible
    // by construction — there is nothing to seal them under.
    throw new Error(`vault is locked, cannot import credentials: ${resolution.reason}`);
  }
  initialize({ dbPath: deps.config.dbPath });
  try {
    const imports = configuredImports(deps.config);
    if (imports.length === 0) {
      lines.push("no channel credentials in env config; nothing to import");
    }
    const now = deps.now();
    for (const entry of imports) {
      importChannel(entry, resolution.kek, now, lines);
    }
  } finally {
    Storage.reset();
  }
  return lines;
}
