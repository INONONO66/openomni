import { ChannelInstanceStore, PersonStore, SecretStore, Vault } from "@openomni/ledger";
import type { ProvisionPort } from "../../src/tools/provision";

/** Real durable stores under a quiet supervisor: enough for address-book authority tests. */
export function provisionPort(): ProvisionPort {
  return {
    persons: PersonStore,
    instances: ChannelInstanceStore,
    secrets: SecretStore,
    kek: { kind: "ok", kek: Vault.kekOf(new Uint8Array(32).fill(7)) },
    supervisor: {
      reconcile: async () => [],
      resume: () => true,
      status: () => [],
      source: () => "declared",
    },
    materialize: () => undefined,
    removeIdentity: () => true,
  };
}
