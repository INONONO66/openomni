import { Provisioning } from "@openomni/protocol";
import type { Storage as ProtocolStorage } from "@openomni/protocol";
import { Storage } from "../storage/storage";

export { Vault } from "./vault";

function requireAdapter(): ProtocolStorage.ProvisioningSubAdapter {
  const sub = Storage.get().provisioning;
  if (sub === undefined || sub === null) {
    throw new Provisioning.StoreError({
      message: "Storage adapter does not implement provisioning",
      code: "adapter_absent",
    });
  }
  return sub;
}

/**
 * Durable Person manifests (docs/provisioning-and-providers.md §3.1).
 * THE sole-owner enforcement layer: at most one Person carries
 * `trustTier: "owner"`, and a second is a typed `owner_exists` refusal —
 * checked inside the adapter's transaction so two concurrent declares
 * cannot both pass the read.
 */
export namespace PersonStore {
  export function put(input: Provisioning.Person): Provisioning.Person {
    const person = Provisioning.Person.parse(input);
    const adapter = requireAdapter();
    return Storage.get().transaction(() => {
      if (person.trustTier === "owner") {
        const owner = adapter.listPersons().find((row) => row.trustTier === "owner");
        if (owner !== undefined && owner.id !== person.id) {
          throw new Provisioning.StoreError({
            message: `Sole-owner invariant: ${owner.id} already holds trustTier "owner"`,
            code: "owner_exists",
            id: owner.id,
          });
        }
      }
      adapter.setPerson(person);
      return person;
    });
  }

  export function get(id: string): Provisioning.Person | undefined {
    return requireAdapter().getPerson(id);
  }

  export function list(): Provisioning.Person[] {
    return requireAdapter().listPersons();
  }

  export function remove(id: string): boolean {
    return requireAdapter().removePerson(id);
  }
}

/** Durable ChannelInstance declarations (§3.2). Reconciliation meaning belongs to the app. */
export namespace ChannelInstanceStore {
  export function put(input: Provisioning.ChannelInstance): Provisioning.ChannelInstance {
    const instance = Provisioning.ChannelInstance.parse(input);
    requireAdapter().setChannelInstance(instance);
    return instance;
  }

  export function get(id: string): Provisioning.ChannelInstance | undefined {
    return requireAdapter().getChannelInstance(id);
  }

  export function list(): Provisioning.ChannelInstance[] {
    return requireAdapter().listChannelInstances();
  }

  export function remove(id: string): boolean {
    return requireAdapter().removeChannelInstance(id);
  }
}

/** Durable vault rows (§3.3): ciphertext in, ciphertext out. Crypto lives in `Vault`. */
export namespace SecretStore {
  export function put(input: Provisioning.Secret): Provisioning.Secret {
    const secret = Provisioning.Secret.parse(input);
    requireAdapter().setSecret(secret);
    return secret;
  }

  export function get(id: string): Provisioning.Secret | undefined {
    return requireAdapter().getSecret(id);
  }

  export function list(): Provisioning.Secret[] {
    return requireAdapter().listSecrets();
  }

  export function remove(id: string): boolean {
    return requireAdapter().removeSecret(id);
  }
}
