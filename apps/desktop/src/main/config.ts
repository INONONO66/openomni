/**
 * The desktop main process's one environment resolution (#1245): the Electron
 * entry passes the host process object once (`bootstrap(process)`), this
 * module resolves every variable the shell consumes, and no other desktop
 * file reads the environment.
 */

interface GatewayEndpoint {
  readonly url: string;
  readonly token?: string;
}

// Copied literal from apps/openomni/src/config.ts (`parseWsPort` default):
// the console must not import the kernel app, so the default port lives here
// as a named copy of its source.
const DEFAULT_WS_PORT = 3000;

// Copied literal from apps/openomni/src/index.ts (the daemon's websocket
// upgrade path): same no-kernel-import reason as the port default above.
const GATEWAY_PATH = "/ws";

/**
 * The env this reads, as a plain record (the ambient environment's shape), so
 * a test needs no ambient process. Consumed keys: OPENOMNI_WS_URL,
 * OPENOMNI_WS_PORT, OPENOMNI_WS_TOKEN, ELECTRON_RENDERER_URL.
 */
export type DesktopEnv = Readonly<Record<string, string | undefined>>;

/** Trimmed, or absent — `export FOO=` yields an empty string, not an unset var. */
function read(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function port(raw: string | undefined): number {
  const value = read(raw);
  if (value === undefined) return DEFAULT_WS_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) return DEFAULT_WS_PORT;
  return parsed;
}

export function resolveGatewayEndpoint(env: DesktopEnv): GatewayEndpoint {
  const url =
    read(env.OPENOMNI_WS_URL) ?? `ws://127.0.0.1:${port(env.OPENOMNI_WS_PORT)}${GATEWAY_PATH}`;
  const token = read(env.OPENOMNI_WS_TOKEN);
  return token === undefined ? { url } : { url, token };
}

export interface DesktopConfig {
  readonly gateway: GatewayEndpoint;
  /** electron-vite's dev-server URL; presence switches the shell into development mode. */
  readonly rendererDevUrl?: string;
}

export function resolveDesktopConfig(env: DesktopEnv): DesktopConfig {
  const rendererDevUrl = read(env.ELECTRON_RENDERER_URL);
  return {
    gateway: resolveGatewayEndpoint(env),
    ...(rendererDevUrl === undefined ? {} : { rendererDevUrl }),
  };
}
