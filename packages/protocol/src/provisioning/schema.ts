import { z } from "zod";
import { Actor } from "../actor/index.js";
import { NamedError } from "../error/index.js";
import { PlainValueSchema } from "../json.js";
import { EpochMs } from "../time.js";

/**
 * Provisioning vocabulary (docs/provisioning-and-providers.md §3): the
 * Owner's standing declarations — who people are (Person), which channels
 * exist (ChannelInstance), and the ciphertext credential rows they reference
 * (Secret). Declarations are durable acts with revision + createdBy; derived
 * state (actor rows, channel grants) is materialized from them at reconcile
 * time and is rebuildable. Durable persistence lives in `@openomni/ledger`.
 */

export const PersonId = z
  .string()
  .regex(/^person:[a-z0-9][a-z0-9-]*$/, "Person id must be person:<slug>");
export type PersonId = z.infer<typeof PersonId>;

export const ChannelInstanceId = z
  .string()
  .regex(
    /^channel:[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9-]*$/,
    "ChannelInstance id must be channel:<provider>:<slug>",
  );
export type ChannelInstanceId = z.infer<typeof ChannelInstanceId>;

export const SecretId = z
  .string()
  .regex(/^secret:[a-z0-9][a-z0-9-]*$/, "Secret id must be secret:<slug>");
export type SecretId = z.infer<typeof SecretId>;

/**
 * One platform identity bound to a Person. `workspace` is the platform's
 * tenant key where the platform has one (Slack team id, GitHub org) —
 * mandatory per provider contract, not per schema. `externalId` is the
 * platform's stable id (numeric/snowflake), never the mutable username.
 */
export const PersonEndpoint = z
  .object({
    channel: z.string().min(1),
    workspace: z.string().min(1).optional(),
    externalId: z.string().min(1),
  })
  .strict();
export type PersonEndpoint = z.infer<typeof PersonEndpoint>;

/**
 * §3.1 identity manifest: the Owner's declaration that a person (or agent)
 * exists, at what standing, reachable at which platform endpoints. Exactly
 * one Person per installation may carry `trustTier: "owner"` — the ledger
 * store enforces it with a typed `owner_exists` refusal.
 */
export const Person = z
  .object({
    id: PersonId,
    displayName: z.string().min(1),
    kind: Actor.Kind,
    trustTier: Actor.TrustTier,
    endpoints: z.array(PersonEndpoint),
    revision: z.number().int().nonnegative(),
    createdBy: z.string().min(1),
    updatedAt: EpochMs,
  })
  .strict();
export type Person = z.infer<typeof Person>;

/**
 * §3.2 perimeter policy block: replaces the hardcoded trusted-channel grant —
 * boot materializes the ChannelGrant row from this declaration.
 */
export const GrantPolicy = z
  .object({
    defaultTier: Actor.TrustTier.optional(),
    allowedSenders: z.array(z.string().min(1)).optional(),
    provisionalMint: z.boolean().optional(),
  })
  .strict();
export type GrantPolicy = z.infer<typeof GrantPolicy>;

/**
 * §3.2: the Owner's declaration that a channel exists and how it is mounted.
 * `settings` carries only non-secret knobs; the credential is a vault
 * reference, never inline. `enabled: false` unmounts the stage without
 * deleting the declaration.
 */
export const ChannelInstance = z
  .object({
    id: ChannelInstanceId,
    provider: z.string().min(1),
    enabled: z.boolean(),
    settings: z.record(z.string(), PlainValueSchema),
    credentialRef: SecretId.optional(),
    grant: GrantPolicy.optional(),
    revision: z.number().int().nonnegative(),
    createdBy: z.string().min(1),
    updatedAt: EpochMs,
  })
  .strict();
export type ChannelInstance = z.infer<typeof ChannelInstance>;

export const SecretPurpose = z.enum(["channel_credential", "webhook_secret"]);
export type SecretPurpose = z.infer<typeof SecretPurpose>;

/**
 * §3.3 vault row: envelope-encrypted ciphertext only. `ciphertext` and
 * `wrappedDek` are packed AES-256-GCM blobs (12-byte IV ‖ 16-byte auth tag ‖
 * data); the DEK is per-secret and wrapped by the KEK named in `kekId`.
 * Plaintext has no field here by construction — the schema is the §8.2 law.
 */
export const Secret = z
  .object({
    id: SecretId,
    ciphertext: z.instanceof(Uint8Array),
    wrappedDek: z.instanceof(Uint8Array),
    kekId: z.string().min(1),
    purpose: SecretPurpose,
    createdAt: EpochMs,
    rotatedAt: EpochMs.optional(),
  })
  .strict();
export type Secret = z.infer<typeof Secret>;

export const StoreErrorCode = z.enum([
  /** Durable writes fail closed when the sub-adapter is missing. */
  "adapter_absent",
  /** §8.8: a second `trustTier: "owner"` Person is a typed refusal, never a silent overwrite. */
  "owner_exists",
]);
export type StoreErrorCode = z.infer<typeof StoreErrorCode>;

/** Typed failure taxonomy for durable provisioning persistence. Callers branch on `data.code`. */
export const StoreError = NamedError.create(
  "ProvisioningStoreError",
  z.object({
    message: z.string(),
    code: StoreErrorCode,
    id: z.string().min(1).optional(),
  }),
);
export type StoreError = InstanceType<typeof StoreError>;

export const VaultErrorCode = z.enum([
  /** §8.4: no usable KEK — dependent channels do not mount; loopback ws stays up. */
  "vault_locked",
  /** Ciphertext or wrapped DEK failed authentication/shape under the presented KEK. */
  "unopenable",
  /** The row was sealed under a different KEK than the one presented. */
  "kek_mismatch",
]);
export type VaultErrorCode = z.infer<typeof VaultErrorCode>;

/** Typed vault failure: decrypt problems are refusals, never silent empty credentials. */
export const VaultError = NamedError.create(
  "ProvisioningVaultError",
  z.object({
    message: z.string(),
    code: VaultErrorCode,
    secretId: z.string().min(1).optional(),
  }),
);
export type VaultError = InstanceType<typeof VaultError>;
