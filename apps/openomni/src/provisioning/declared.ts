import { homedir } from "node:os";
import { ActorRegistry, ChannelInstanceStore, PersonStore, SecretStore, Vault } from "@openomni/ledger";
import { type CredentialReader, channelProfile, declaredChannelProfile } from "../channels";
import type { OpenOmniConfig } from "../config";
import { MOUNTED_CHANNEL_DEFAULT_TIER } from "../gateway";
import type { DesiredChannels } from "./supervisor";
import { type KekResolution, resolveKek } from "./vault-key";

/**
 * Boot-time reconciliation of the provisioning store
 * (docs/provisioning-and-providers.md §6, §8.1): once any ChannelInstance is
 * declared, the store is the sole source of channel truth and env channel
 * config is a ghost — visible in the selection's `source`, never mounted.
 */

/** Binds the vault seam for `declaredChannelProfile`: store row + KEK → plaintext or a locked reason. */
export function vaultCredentialReader(resolution: KekResolution): CredentialReader {
  if (resolution.kind === "locked") {
    return () => ({ kind: "locked", reason: resolution.reason });
  }
  const kek = resolution.kek;
  return (ref) => {
    const secret = SecretStore.get(ref);
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
 * What the supervisor should be running right now (`declared` iff at least
 * one ChannelInstance row exists — env config is shadowed then, §8.1). The
 * bounce key folds the declaration revision with the secret's rotation epoch,
 * so `channel_declare` edits and `secret_rotate` both bounce exactly the
 * stages they touch (§8.7) while everything else keeps running.
 */
export function desiredChannels(
  config: OpenOmniConfig,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): DesiredChannels {
  const instances = ChannelInstanceStore.list();
  if (instances.length === 0) {
    return {
      source: "env",
      rows: channelProfile(config).map((component) => ({
        instanceId: `env:${component.id}`,
        key: "env",
        component,
        // Env channel config declares credentials only — it carries no Owner
        // tier decision, so env rows mount at the mount tier (#931).
        defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER,
      })),
      statuses: [],
    };
  }
  const reader = vaultCredentialReader(resolveKek(env, home));
  const { rows, statuses } = declaredChannelProfile(instances, reader);
  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  return {
    source: "declared",
    rows: rows.map((row) => {
      const instance = byId.get(row.instanceId);
      const secret =
        instance?.credentialRef === undefined ? undefined : SecretStore.get(instance.credentialRef);
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
