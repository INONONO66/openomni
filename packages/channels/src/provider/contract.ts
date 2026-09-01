import type { Channel } from "@openomni/protocol";
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
