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
import type { Channel } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { OpenOmniConfig } from "./config";

export interface BuiltChannel {
  readonly surface: Channel.Surface;
  /** Outbound seam, keyed by `surface.id`: present only for channels the Resident can message into. */
  readonly deliveryRoute?: ProviderDeliveryRoute;
  /** Ingress seam: present only for webhook-fed channels. */
  readonly webhookHandler?: (request: Request) => Promise<Response>;
}

interface ChannelComponent {
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
