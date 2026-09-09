export interface GatewayEndpoint {
  readonly url: string;
  readonly token?: string;
}

const DEFAULT_WS_PORT = 3000;

const GATEWAY_PATH = "/ws";

/** The env this reads, as a record, so a test needs no ambient process. */
interface GatewayEnv {
  readonly OPENOMNI_WS_URL?: string;
  readonly OPENOMNI_WS_PORT?: string;
  readonly OPENOMNI_WS_TOKEN?: string;
}

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

export function resolveGatewayEndpoint(env: GatewayEnv): GatewayEndpoint {
  const url =
    read(env.OPENOMNI_WS_URL) ?? `ws://127.0.0.1:${port(env.OPENOMNI_WS_PORT)}${GATEWAY_PATH}`;
  const token = read(env.OPENOMNI_WS_TOKEN);
  return token === undefined ? { url } : { url, token };
}
