/**
 * Channel profile — the declarative row list of external channel components.
 *
 * Each configured channel is one row: a provider from the shipped registry
 * plus the credential payload and trigger policy this installation mounts it
 * with. The profile is data — boot mounts each row as its own composition
 * stage, so what the app composes is readable here in one place, and
 * disposing a stage revokes exactly that channel's listening, deliverability,
 * and trusted-channel authority.
 *
 * A row exists only for a configured channel. There is no disabled-row state
 * and no default credential — absence of config is absence of the component.
 */

import type { ChannelProvider, ProviderDeliveryRoute } from "@openomni/channels";
import { ChannelProviders } from "@openomni/channels";
import type { Channel, Provisioning } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { z } from "zod";
import type { OpenOmniConfig } from "./config";

export interface BuiltChannel {
  readonly surface: Channel.Surface;
  /** Outbound seam, keyed by `surface.id`: present only for channels the Resident can message into. */
  readonly deliveryRoute?: ProviderDeliveryRoute;
  /** Ingress seam: present only for webhook-fed channels. */
  readonly webhookHandler?: (request: Request) => Promise<Response>;
}

export interface ChannelComponent {
  readonly id: keyof typeof ChannelProviders;
  /** Constructs the surface and binds the Resident handler. Called once per boot. */
  build(handler: Channel.MessageHandler): BuiltChannel;
}

/**
 * One row: construct the provider runtime with the installation's typed
 * credential and bind the Resident handler. Credential admission happened
 * where the values entered the process (config.ts: a blank token is an
 * absent channel, never a mounted-empty one) — one enforcement layer per
 * invariant, so no re-validation here.
 */
function providerRow<TCredentials, TId extends keyof typeof ChannelProviders>(
  provider: ChannelProvider<TCredentials, TId>,
  credentials: TCredentials,
  config: Channel.Config,
): ChannelComponent {
  return {
    id: provider.id,
    build(handler) {
      const runtime = provider.create(credentials, config, Bus.publish);
      runtime.surface.onMessage(handler);
      return {
        surface: runtime.surface,
        ...(runtime.deliveryRoute === undefined ? {} : { deliveryRoute: runtime.deliveryRoute }),
        ...(runtime.webhookHandler === undefined
          ? {}
          : { webhookHandler: runtime.webhookHandler }),
      };
    },
  };
}

/** One row per configured channel, in composition order. */
export function channelProfile(
  config: OpenOmniConfig,
  providers: typeof ChannelProviders = ChannelProviders,
): ChannelComponent[] {
  const rows: ChannelComponent[] = [];

  const telegramConfig = config.channels?.telegram;
  if (telegramConfig !== undefined) {
    rows.push(providerRow(providers.telegram, { token: telegramConfig.token }, { triggers: [] }));
  }

  const githubConfig = config.channels?.github;
  if (githubConfig !== undefined) {
    rows.push(
      providerRow(
        providers.github,
        {
          secret: githubConfig.secret,
          ...(githubConfig.token === undefined ? {} : { token: githubConfig.token }),
          ...(githubConfig.botUsername === undefined
            ? {}
            : { botUsername: githubConfig.botUsername }),
        },
        { triggers: [{ type: "event", events: ["issue_comment.created", "issues.opened"] }] },
      ),
    );
  }

  const discordConfig = config.channels?.discord;
  if (discordConfig !== undefined) {
    rows.push(
      providerRow(
        providers.discord,
        { token: discordConfig.token },
        { triggers: [{ type: "mention" }] },
      ),
    );
  }

  return rows;
}

/**
 * Trigger policy per provider — identical to the env-config path above by
 * design (PR-B changes where credentials live, not how channels behave).
 * Per-instance trigger settings arrive with the runtime-administration PR.
 */
const DECLARED_TRIGGERS: Record<keyof typeof ChannelProviders, Channel.Config["triggers"]> = {
  telegram: [],
  github: [{ type: "event", events: ["issue_comment.created", "issues.opened"] }],
  discord: [{ type: "mention" }],
  slack: [{ type: "mention" }],
};

type DeclaredChannelState =
  | "ready"
  | "disabled"
  | "vault_locked"
  | "unknown_provider"
  | "missing_credential"
  | "credential_invalid";

/** Per-declaration reconcile verdict — the honest boot record of why a row did or did not mount. */
export interface DeclaredChannelStatus {
  readonly id: string;
  readonly provider: string;
  readonly state: DeclaredChannelState;
  readonly detail?: string;
}

/** Vault read seam: `locked` covers both a missing/unusable KEK and a missing/unopenable row. */
export type CredentialReader = (
  ref: string,
) => { kind: "ok"; plaintext: Uint8Array } | { kind: "locked"; reason: string };

/**
 * Vault plaintexts are JSON credential payloads. The provider's own
 * `credentials` schema is THE validation layer for DB-sourced credentials —
 * the trust boundary where ciphertext from the provisioning store becomes
 * the provider's typed credential.
 */
function credentialRow<TCredentials, TId extends keyof typeof ChannelProviders>(
  provider: ChannelProvider<TCredentials, TId>,
  plaintext: Uint8Array,
): ChannelComponent | { readonly invalid: string } {
  let parsed: z.ZodSafeParseResult<TCredentials>;
  try {
    parsed = provider.credentials.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch (error) {
    return { invalid: `credential payload is not JSON (${String(error)})` };
  }
  if (!parsed.success) return { invalid: parsed.error.message };
  return providerRow(provider, parsed.data, { triggers: DECLARED_TRIGGERS[provider.id] });
}

function declaredRow(
  key: keyof typeof ChannelProviders,
  plaintext: Uint8Array,
  providers: typeof ChannelProviders,
): ChannelComponent | { readonly invalid: string } {
  if (key === "telegram") {
    return credentialRow(providers.telegram, plaintext);
  }
  if (key === "discord") {
    return credentialRow(providers.discord, plaintext);
  }
  if (key === "slack") {
    return credentialRow(providers.slack, plaintext);
  }
  return credentialRow(providers.github, plaintext);
}

export function isRegisteredProvider(provider: string): provider is keyof typeof ChannelProviders {
  return provider in ChannelProviders;
}

/**
 * The pre-persist credential gate for `channel_declare`/`secret_rotate`
 * (docs/provisioning-and-providers.md §5): the payload must parse under the
 * provider's credential schema BEFORE any row lands — an invalid credential
 * is a typed refusal string, and nothing is sealed or mounted.
 */
export function validateProviderCredential(
  provider: string,
  payload: Record<string, string>,
): string | undefined {
  if (!isRegisteredProvider(provider)) {
    return `unknown provider ${provider}`;
  }
  const parsed = ChannelProviders[provider].credentials.safeParse(payload);
  return parsed.success ? undefined : parsed.error.message;
}

/**
 * The pre-persist settings gate for `channel_declare`: knobs must parse under
 * the provider's `settings` schema before the row lands. No shipped provider
 * carries knobs yet, so any settings key is a typed refusal — never
 * accepted-and-ignored.
 */
export function validateProviderSettings(
  provider: string,
  settings: Record<string, string | number | boolean>,
): string | undefined {
  if (!isRegisteredProvider(provider)) {
    return `unknown provider ${provider}`;
  }
  const parsed = ChannelProviders[provider].settings.safeParse(settings);
  return parsed.success ? undefined : parsed.error.message;
}

/** A declaration the profile could mount: the instance it came from plus its built row. */
export interface DeclaredChannelRow {
  readonly instanceId: string;
  readonly component: ChannelComponent;
}

/**
 * The declared path (docs/provisioning-and-providers.md §8.1): one row per
 * ChannelInstance declaration, credentials opened through the vault seam.
 * Fail-closed per row — a declaration that cannot mount is a status, never a
 * half-wired driver, and never a reason to stop the rest of the boot (§8.4:
 * the credential-less loopback surface must survive a locked vault).
 */
export function declaredChannelProfile(
  instances: readonly Provisioning.ChannelInstance[],
  readCredential: CredentialReader,
  providers: typeof ChannelProviders = ChannelProviders,
): { rows: DeclaredChannelRow[]; statuses: DeclaredChannelStatus[] } {
  const rows: DeclaredChannelRow[] = [];
  const statuses: DeclaredChannelStatus[] = [];
  const record = (
    instance: Provisioning.ChannelInstance,
    state: DeclaredChannelState,
    detail?: string,
  ) => {
    statuses.push({
      id: instance.id,
      provider: instance.provider,
      state,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  for (const instance of instances) {
    if (!instance.enabled) {
      record(instance, "disabled");
      continue;
    }
    if (!isRegisteredProvider(instance.provider)) {
      record(instance, "unknown_provider");
      continue;
    }
    if (instance.credentialRef === undefined) {
      record(instance, "missing_credential");
      continue;
    }
    const credential = readCredential(instance.credentialRef);
    if (credential.kind === "locked") {
      record(instance, "vault_locked", credential.reason);
      continue;
    }
    const row = declaredRow(instance.provider, credential.plaintext, providers);
    if ("invalid" in row) {
      record(instance, "credential_invalid", row.invalid);
      continue;
    }
    record(instance, "ready");
    rows.push({ instanceId: instance.id, component: row });
  }

  return { rows, statuses };
}
