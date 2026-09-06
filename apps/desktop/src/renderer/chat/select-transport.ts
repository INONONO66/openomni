import type { ChatTransport, UIMessage } from "ai";
import type { GatewayEndpoint } from "../../preload/api";
import { createGatewayChatTransport } from "./gateway-transport";

/**
 * Which wire the renderer speaks, decided in one pure function.
 *
 * It is pure and separate from `app.tsx` for one reason: the difference between
 * these two transports is the difference between a real conversation and a
 * fabricated one, and a shell that quietly fell back to the mock while a
 * gateway was configured would show the Owner a fluent answer to a question
 * nothing ever received. That is not a defect a screenshot catches, so it is
 * asserted directly.
 *
 * The mock is not a placeholder for a missing feature — it is the correct
 * answer when there is no Electron main behind the renderer at all, which is
 * how the showcase and `scripts/shoot-chat.ts` render this same bundle.
 *
 * It returns the mock as `undefined` rather than as a constructed transport,
 * and that is deliberate: the mock's tuning (one chunk per animation frame) is
 * a property of the SURFACE, owned by `app.tsx`, and a second mock built here
 * would silently outrank it — a stream that finishes before it paints, which is
 * how the in-flight state disappeared once already.
 */

export type SelectedTransport =
  | { readonly kind: "gateway"; readonly transport: ChatTransport<UIMessage>; readonly protocols?: readonly string[] }
  | { readonly kind: "mock"; readonly transport: undefined; readonly protocols?: undefined };

/**
 * The token's place on the wire.
 *
 * `packages/channels/src/authn/websocket.ts` reads the `Sec-WebSocket-Protocol`
 * header, finds the literal `auth`, and takes the NEXT protocol as the
 * credential. So the offer is a pair, in that order; a bare token would be an
 * unrecognised protocol and authenticate nothing.
 */
function authProtocols(token: string): readonly string[] {
  return ["auth", token];
}

export function selectChatTransport(endpoint: GatewayEndpoint | undefined): SelectedTransport {
  if (endpoint === undefined) return { kind: "mock", transport: undefined };

  // No token means no offer at all, rather than an empty one: a loopback
  // gateway with no configured token has nothing to match an `auth` pair
  // against, and answers the attempt with a 401.
  if (endpoint.token === undefined || endpoint.token.length === 0) {
    return { kind: "gateway", transport: createGatewayChatTransport({ url: endpoint.url }) };
  }

  const protocols = authProtocols(endpoint.token);
  return {
    kind: "gateway",
    transport: createGatewayChatTransport({ url: endpoint.url, protocols }),
    protocols,
  };
}
