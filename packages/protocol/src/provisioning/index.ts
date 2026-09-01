import * as Schema from "./schema.js";

/**
 * Provisioning namespace (docs/provisioning-and-providers.md §3): Person /
 * ChannelInstance / Secret declaration schemas and the typed store + vault
 * errors. Envelope crypto and durable persistence live in
 * `@openomni/ledger`'s provisioning band.
 */
export namespace Provisioning {
  export const PersonId = Schema.PersonId;
  export type PersonId = Schema.PersonId;

  export const PersonEndpoint = Schema.PersonEndpoint;
  export type PersonEndpoint = Schema.PersonEndpoint;

  export const Person = Schema.Person;
  export type Person = Schema.Person;

  export const ChannelInstanceId = Schema.ChannelInstanceId;
  export type ChannelInstanceId = Schema.ChannelInstanceId;

  export const GrantPolicy = Schema.GrantPolicy;
  export type GrantPolicy = Schema.GrantPolicy;

  export const ChannelInstance = Schema.ChannelInstance;
  export type ChannelInstance = Schema.ChannelInstance;

  export const SecretId = Schema.SecretId;
  export type SecretId = Schema.SecretId;

  export const SecretPurpose = Schema.SecretPurpose;
  export type SecretPurpose = Schema.SecretPurpose;

  export const Secret = Schema.Secret;
  export type Secret = Schema.Secret;

  export const StoreErrorCode = Schema.StoreErrorCode;
  export type StoreErrorCode = Schema.StoreErrorCode;

  export const StoreError = Schema.StoreError;
  export type StoreError = InstanceType<typeof Schema.StoreError>;

  export const VaultErrorCode = Schema.VaultErrorCode;
  export type VaultErrorCode = Schema.VaultErrorCode;

  export const VaultError = Schema.VaultError;
  export type VaultError = InstanceType<typeof Schema.VaultError>;
}
