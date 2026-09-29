import * as Schema from "./schema.js";

/**
 * Provisioning namespace (docs/provisioning-and-providers.md §3): Person /
 * ChannelInstance / Secret declaration schemas and the typed store + vault
 * errors. Envelope crypto and durable persistence live in
 * `@openomni/ledger`'s provisioning band.
 */
export namespace Provisioning {
  export const Person = Schema.Person;
  export type Person = Schema.Person;

  export const ChannelInstance = Schema.ChannelInstance;
  export type ChannelInstance = Schema.ChannelInstance;

  export const Secret = Schema.Secret;
  export type Secret = Schema.Secret;

  export const StoreError = Schema.StoreError;
  export type StoreError = InstanceType<typeof Schema.StoreError>;

  export const VaultError = Schema.VaultError;
  export type VaultError = InstanceType<typeof Schema.VaultError>;
}
