import type { Channel } from "@openomni/protocol";
import type { z } from "zod";
import type { PublishPort } from "../types.js";

/**
 * Existing-agent delivery through this provider, keyed by ActorEndpoint
 * externalId. Structurally identical to the router's `ChannelDeliveryRoute`
 * on purpose: the provider band may not import `src/router/` (S8 banding), so
 * the contract restates the seam and the composition root is where the two
 * meet. The optional `idempotencyKey` mirrors the adapters' deliver seam —
 * the current server composition calls it keyless (at-least-once retained).
 */
export type ProviderDeliveryRoute = (
  externalId: string,
  body: string,
  idempotencyKey?: string,
) => Promise<{ readonly externalMessageId?: string }>;

/**
 * How a provider receives platform events. The runner does not interpret the
 * mode — each provider's surface owns its transport — but the mode is part of
 * the declared contract so composition and docs state it instead of readers
 * reverse-engineering it from the driver.
 *
 * - `poll`    — the surface polls the platform API (telegram).
 * - `socket`  — the surface holds an outbound socket the platform pushes
 *               through (discord gateway, slack Socket Mode).
 * - `webhook` — the platform calls into `ProviderRuntime.webhookHandler`
 *               (github).
 * - `bridge`  — an external daemon fronts the platform and the surface talks
 *               to the daemon (signal, whatsapp; none shipped yet).
 */
export type IngestMode = "poll" | "socket" | "webhook" | "bridge";

/**
 * Outbound text policy the provider's surface applies before sending: the
 * markdown dialect mapping and the hard per-message length it chunks to.
 * Declared here and consumed by the surface itself (each driver's
 * `format.ts` is the single source), so composition and docs read the
 * policy instead of reverse-engineering the send path.
 */
export interface RenderPolicy {
  /**
   * Maps Resident markdown to the platform dialect; identity where the
   * platform accepts the text as-is (slack mrkdwn, github comments).
   */
  readonly renderMarkdown: (markdown: string) => string;
  /**
   * Hard per-message length the surface chunks outbound text to. `null`
   * where the driver enforces no limit (github comments).
   */
  readonly messageLimit: number | null;
}

/**
 * What a provider's runtime exposes, declared statically so composition and
 * conformance tests can check the runtime against the declaration instead of
 * duck-typing the constructed object (the `DeliveringSurface` casts this
 * replaces).
 */
export interface ProviderCapabilities {
  /** The runtime exposes `deliveryRoute` — the Resident can message into it. */
  readonly deliver: boolean;
  /** The runtime exposes `webhookHandler` — ingress arrives over HTTP. */
  readonly webhook: boolean;
  /** Outbound text policy the surface applies (dialect + chunk limit). */
  readonly render: RenderPolicy;
}

/**
 * One constructed channel instance: the surface plus its optional seams. The
 * seams mirror `ProviderCapabilities` — a provider declaring `deliver` MUST
 * return `deliveryRoute`, one declaring `webhook` MUST return
 * `webhookHandler`, and one declaring neither returns neither. The provider
 * conformance suite enforces the correspondence.
 */
export interface ProviderRuntime {
  readonly surface: Channel.Surface;
  readonly deliveryRoute?: ProviderDeliveryRoute;
  readonly webhookHandler?: (request: Request) => Promise<Response>;
}

/**
 * The uniform channel driver contract. A provider is data plus one
 * constructor: adding a platform means implementing this interface and
 * registering it — composition code never grows a platform-specific branch.
 *
 * Providers stay in the driver sub-band: protocol types, their own transport,
 * and the injected `PublishPort` only. Authority (grants, blacklist, tiers,
 * admission) remains router-side.
 */
export interface ChannelProvider<TCredentials, TId extends string = string> {
  readonly id: TId;
  readonly ingest: IngestMode;
  readonly capabilities: ProviderCapabilities;
  /**
   * THE schema for this provider's secret payload — the app's credential
   * gates (boot declared rows, `channel_declare`/`secret_rotate`) validate
   * against this declaration instead of owning a parallel table. Shapes are
   * genuinely heterogeneous by platform (telegram: one token; slack: two).
   */
  readonly credentials: z.ZodType<TCredentials>;
  /**
   * Non-secret instance knobs. No shipped provider carries knobs yet, so
   * every schema is the empty record (`z.record(z.never())`) — the seam
   * exists so `ChannelInstance.settings` is validated where it enters
   * (`channel_declare`) instead of accepted-and-ignored.
   */
  readonly settings: z.ZodType<Record<string, never>>;
  /**
   * Operator checklist the credential cannot carry and the runner cannot
   * verify — portal-side switches (Discord gateway intents, Slack app
   * scopes). `provision_status` reports these verbatim; nothing enforces
   * them (they fail loudly at the platform, not here).
   */
  readonly preconditions: readonly string[];
  /**
   * Constructs the surface and seams. Pure construction — no I/O until
   * `surface.start()`. `TCredentials` is this provider's typed secret
   * material, heterogeneous by design (telegram: one bot token; github: a
   * webhook secret plus optional API token). Validation stays where the
   * credential enters the system (env config today, the provisioning store
   * later) — one enforcement layer per invariant, so the contract takes the
   * already-trusted typed value.
   */
  create(
    credentials: TCredentials,
    config: Channel.Config,
    publish: PublishPort,
  ): ProviderRuntime;
}
