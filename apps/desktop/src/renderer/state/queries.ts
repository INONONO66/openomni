import { useQuery } from "@tanstack/react-query";
import type { GatewayEndpoint } from "../../preload/api";

/**
 * The renderer's SERVER state: everything a process outside this window
 * answers for, read through TanStack Query so loading, error, and caching are
 * one mechanism instead of one `useEffect` per fact.
 *
 * Every key is minted here. A component that spelled its own key would be a
 * second place for the same fact to be cached under a different name.
 *
 * There is no `sessions` key: the gateway's WebSocket wire has no session-list
 * or history method yet, so the session list is client state (`store.ts`)
 * until the wire can answer for it.
 */
export const queryKeys = {
  gatewayEndpoint: ["gateway", "endpoint"] as const,
};

/**
 * Where the gateway is, asked of Electron main over the preload bridge.
 *
 * `null` is a real answer, not a failure: the bridge is absent whenever this
 * bundle runs outside Electron (a test, a plain HTTP preview), and a build
 * with no gateway configured answers the same way. Both leave the composer
 * disabled rather than talking to anything fabricated.
 *
 * A REJECTED invoke — the main process has no handler, an older shell around a
 * newer renderer — is left as the query's error so the surface can print it.
 * Never retried: the answer comes from an environment read once at boot, and
 * the second ask would get the same one.
 */
export function useGatewayEndpoint() {
  return useQuery({
    queryKey: queryKeys.gatewayEndpoint,
    queryFn: fetchGatewayEndpoint,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

async function fetchGatewayEndpoint(): Promise<GatewayEndpoint | null> {
  const bridge = (globalThis as { readonly desktop?: Window["desktop"] }).desktop;
  if (bridge === undefined) return null;
  return (await bridge.gateway()) ?? null;
}
