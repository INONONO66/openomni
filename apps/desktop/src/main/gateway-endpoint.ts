/**
 * Where the gateway is, decided once, from the environment.
 *
 * The renderer runs with `contextIsolation` on and no Node: it cannot read an
 * env var, and it should not — a renderer that could would be a renderer that
 * could read every other one too. So the main process answers the question and
 * the preload hands the answer across a single `contextBridge` call.
 *
 * This module is deliberately free of `electron` and of `process`: it is a pure
 * function of a plain record, which is what lets the fallback be tested without
 * a window. `src/main/index.ts` is the only place `process.env` is read.
 */

/**
 * The gateway's WebSocket endpoint, and the credential to present at upgrade.
 *
 * `token` is absent rather than empty when unset. An empty string is a real
 * offer on the wire — `["auth", ""]` — and the gateway answers it with a 401,
 * which is a harder failure to read than never having offered.
 */
export interface GatewayEndpoint {
  readonly url: string;
  readonly token?: string;
}

/**
 * The daemon's default WebSocket port.
 *
 * Copied from `parseWsPort` in `apps/openomni/src/config.ts`, which is where
 * the daemon's own default lives. It is a literal rather than an import
 * because the repository topology (`script/check-deps.ts`, and the table in
 * AGENTS.md) allows `apps/desktop` to depend on `protocol` and `ui` only — the
 * console must not pull the deployable app into its bundle to learn a number.
 * `apps/desktop/test/gateway-endpoint.test.ts` is the copy's alarm.
 */
const DEFAULT_WS_PORT = 3000;

/**
 * The gateway's upgrade path, from `createHttpRoutes` in
 * `apps/openomni/src/index.ts`: the daemon upgrades `/ws` and answers 404
 * everywhere else, so a bare `ws://host:port` would never connect.
 *
 * It is appended ONLY to the derived loopback URL. An operator who set
 * `OPENOMNI_WS_URL` has already stated the whole endpoint — behind a proxy the
 * path may be anything — and rewriting their answer would be this module
 * deciding something it was told.
 */
const GATEWAY_PATH = "/ws";

/** The env this reads, as a record, so a test needs no ambient process. */
export interface GatewayEnv {
  readonly OPENOMNI_WS_URL?: string;
  readonly OPENOMNI_WS_PORT?: string;
  readonly OPENOMNI_WS_TOKEN?: string;
}

/** Trimmed, or absent — `export FOO=` yields an empty string, not an unset var. */
function read(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The port, or the daemon's default.
 *
 * A malformed port resolves to the default instead of throwing, and that
 * differs from `parseWsPort` on purpose: the daemon refusing to boot on a bad
 * port is correct, because the alternative is a server bound somewhere nobody
 * asked for. The console has no such stake — refusing to open the window over a
 * typo would leave the Owner with no surface at all, and the connection failure
 * they get instead names the address it tried.
 */
function port(raw: string | undefined): number {
  const value = read(raw);
  if (value === undefined) return DEFAULT_WS_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) return DEFAULT_WS_PORT;
  return parsed;
}

export function resolveGatewayEndpoint(env: GatewayEnv): GatewayEndpoint {
  const url =
    read(env.OPENOMNI_WS_URL) ?? `ws://127.0.0.1:${port(env.OPENOMNI_WS_PORT)}${GATEWAY_PATH}`;
  const token = read(env.OPENOMNI_WS_TOKEN);
  return token === undefined ? { url } : { url, token };
}
