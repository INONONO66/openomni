import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Vault } from "@openomni/ledger";

/**
 * KEK sourcing (docs/provisioning-and-providers.md §3.3): the key encryption
 * key never lives in the database it protects. Resolution order is
 * `OPENOMNI_VAULT_KEY` (base64, 32 bytes) then `~/.openomni/vault.key`
 * (base64 text file, 0600). Every failure shape is `locked` with a reason —
 * a locked vault refuses credentialed channels, it never mounts them empty
 * (§8.4), and the boot proceeds on the credential-less loopback surface.
 */

export type KekResolution =
  | { readonly kind: "ok"; readonly kek: Vault.Kek }
  | { readonly kind: "locked"; readonly reason: string };

export function vaultKeyPath(home: string): string {
  return join(home, ".openomni", "vault.key");
}

function kekFromBase64(encoded: string, source: string): KekResolution {
  // Buffer.from(_, "base64") never throws — bad characters shrink the output,
  // and a wrong-length result is exactly what kekOf refuses below.
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  try {
    return { kind: "ok", kek: Vault.kekOf(bytes) };
  } catch (error) {
    return { kind: "locked", reason: `${source}: ${String(error)}` };
  }
}

export function resolveKek(env: Record<string, string | undefined>, home: string): KekResolution {
  const fromEnv = env.OPENOMNI_VAULT_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return kekFromBase64(fromEnv, "OPENOMNI_VAULT_KEY");
  }
  const path = vaultKeyPath(home);
  if (!existsSync(path)) {
    return { kind: "locked", reason: `no OPENOMNI_VAULT_KEY and no key file at ${path}` };
  }
  return kekFromBase64(readFileSync(path, "utf-8").trim(), path);
}

/** `openomni init`: mints the key file once; an existing file is never overwritten. */
export function ensureVaultKeyFile(home: string): { readonly path: string; readonly created: boolean } {
  const path = vaultKeyPath(home);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  writeFileSync(path, `${Buffer.from(key).toString("base64")}\n`, { mode: 0o600 });
  // mkdir/write honor umask; the vault key's 0600 is a law, not a suggestion.
  chmodSync(path, 0o600);
  return { path, created: true };
}
