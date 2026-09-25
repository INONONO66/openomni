import { homedir } from "node:os";
import {
  ActorRegistry,
  ChannelInstanceStore,
  PersonStore,
  SecretStore,
  Vault,
} from "@openomni/ledger";
import { type CredentialReader, declaredChannelProfile } from "../channels";
import { MOUNTED_CHANNEL_DEFAULT_TIER } from "../gateway";
import type { DesiredChannels } from "./supervisor";
import { type KekResolution, resolveKek } from "./vault-key";

/**
 * Boot-time reconciliation of the provisioning store
 * (docs/provisioning-and-providers.md §6): ChannelInstanceStore is the sole
 * source of channel truth, including when no instances are declared.
 */

/** Binds the vault seam for `declaredChannelProfile`: store row + KEK → plaintext or a locked reason. */
export function vaultCredentialReader(
  resolution: KekResolution,
  readSecret: typeof SecretStore.get = SecretStore.get,
): CredentialReader {
  if (resolution.kind === "locked") {
    return () => ({ kind: "locked", reason: resolution.reason });
  }
  const kek = resolution.kek;
  return (ref) => {
    const secret = readSecret(ref);
    if (secret === undefined) {
      return { kind: "locked", reason: `no vault row for credentialRef ${ref}` };
    }
    try {
      return { kind: "ok", plaintext: Vault.open(secret, kek).reveal() };
    } catch (error) {
      return { kind: "locked", reason: String(error) };
    }
  };
}

/**
 * What the supervisor should be running from ChannelInstance declarations. The
 * bounce key folds the declaration revision with the secret's rotation epoch,
 * so `channel_add` edits and `secret_rotate` both bounce exactly the
 * stages they touch (§8.7) while everything else keeps running.
 */
export function desiredChannels(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): DesiredChannels {
  const instances = ChannelInstanceStore.list();
  const secrets = new Map<string, ReturnType<typeof SecretStore.get>>();
  const readSecret: typeof SecretStore.get = (ref) => {
    if (!secrets.has(ref)) secrets.set(ref, SecretStore.get(ref));
    return secrets.get(ref);
  };
  const reader = vaultCredentialReader(resolveKek(env, home), readSecret);
  const { rows, statuses } = declaredChannelProfile(instances, reader);
  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  return {
    source: "declared",
    rows: rows.map((row) => {
      const instance = byId.get(row.instanceId);
      const secret =
        instance?.credentialRef === undefined ? undefined : readSecret(instance.credentialRef);
      const rotation = secret?.rotatedAt ?? secret?.createdAt ?? 0;
      return {
        instanceId: row.instanceId,
        key: `${instance?.revision ?? 0}:${rotation}`,
        component: row.component,
        // §3.2 grant block: the declaration is where the Owner raises a
        // surface's tier; absent, the row mounts at the mount tier (#931).
        defaultTier: instance?.grant?.defaultTier ?? MOUNTED_CHANNEL_DEFAULT_TIER,
      };
    }),
    statuses,
  };
}

/**
 * Person manifests become durable identity facts the way env actors do:
 * an idempotent upsert per boot, one identity per Person and one endpoint
 * per platform binding. The sole-owner invariant was already enforced at
 * write time (PersonStore.put) — materialization just replays the manifest.
 */
export function materializePersons(): void {
  for (const person of PersonStore.list()) {
    ActorRegistry.registerIdentity({
      id: person.id,
      kind: person.kind,
      trustTier: person.trustTier,
      ...(person.displayName === undefined ? {} : { displayName: person.displayName }),
    });
    for (const endpoint of person.endpoints) {
      ActorRegistry.registerEndpoint({
        id: `${endpoint.channel}:${endpoint.externalId}`,
        actorId: person.id,
        channel: endpoint.channel,
        externalId: endpoint.externalId,
        ...(endpoint.workspace === undefined ? {} : { workspace: endpoint.workspace }),
      });
    }
  }
}
