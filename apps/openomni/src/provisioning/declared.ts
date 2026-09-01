import { homedir } from "node:os";
import { ActorRegistry, ChannelInstanceStore, PersonStore, SecretStore, Vault } from "@openomni/ledger";
import {
  type ChannelComponent,
  type CredentialReader,
  type DeclaredChannelStatus,
  channelProfile,
  declaredChannelProfile,
} from "../channels";
import type { OpenOmniConfig } from "../config";
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

export interface ChannelProfileSelection {
  /** `declared` iff at least one ChannelInstance row exists — env config is shadowed then. */
  readonly source: "declared" | "env";
  readonly rows: ChannelComponent[];
  readonly statuses: DeclaredChannelStatus[];
}

export function selectChannelProfile(
  config: OpenOmniConfig,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): ChannelProfileSelection {
  const instances = ChannelInstanceStore.list();
  if (instances.length === 0) {
    return { source: "env", rows: channelProfile(config), statuses: [] };
  }
  const reader = vaultCredentialReader(resolveKek(env, home));
  const { rows, statuses } = declaredChannelProfile(instances, reader);
  return { source: "declared", rows, statuses };
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
