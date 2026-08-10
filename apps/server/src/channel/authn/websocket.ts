import { Operational } from "@openomni/protocol";
import type { Policy } from "@openomni/protocol";
import { WebSocketToken } from "./definitions";
import { evaluateChannelPermission, recordDecision } from "./decision";
import type { ChannelAuthnDecisionObserver, WebSocketAuthResult } from "./types";
import type { PublishPort } from "../types";

interface WebSocketAuthState {
  readonly request: Request;
  readonly publish: PublishPort;
  readonly token?: string;
  headers?: Record<string, string>;
  response?: Response;
}

function readSubprotocolAuth(
  req: Request,
): { readonly token: string; readonly selected: string } | undefined {
  const header = req.headers.get("sec-websocket-protocol");
  const protocols = header
    ?.split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  if (!protocols) return undefined;

  const authIndex = protocols.indexOf("auth");
  const token = authIndex >= 0 ? protocols[authIndex + 1] : undefined;
  return token ? { token, selected: "auth" } : undefined;
}

function evaluateWebSocketToken(state: WebSocketAuthState): Policy.PolicyDecision {
  const policyId = "channel.authn.websocket-token";
  if (!state.token) {
    return evaluateChannelPermission({
      action: policyId,
      resource: "websocket.upgrade",
      field: "authenticated",
      allowed: true,
      allowReason: "websocket token auth not configured",
      denyReason: "websocket token missing or invalid",
    });
  }

  const url = new URL(state.request.url);
  const subprotocolAuth = readSubprotocolAuth(state.request);
  const provided = subprotocolAuth?.token ?? url.searchParams.get("token");
  if (provided !== state.token) {
    state.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "websocket auth failure",
    });
    state.response = new Response("Unauthorized", { status: 401 });
    return evaluateChannelPermission({
      action: policyId,
      resource: "websocket.upgrade",
      field: "authenticated",
      allowed: false,
      allowReason: "websocket token accepted",
      denyReason: "websocket token missing or invalid",
    });
  }

  if (subprotocolAuth) {
    state.headers = { "Sec-WebSocket-Protocol": subprotocolAuth.selected };
    return evaluateChannelPermission({
      action: policyId,
      resource: "websocket.upgrade",
      field: "authenticated",
      allowed: true,
      allowReason: "websocket subprotocol token accepted",
      denyReason: "websocket token missing or invalid",
    });
  }

  state.publish(Operational.Warn, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "websocket query token auth is deprecated",
  });
  return evaluateChannelPermission({
    action: policyId,
    resource: "websocket.upgrade",
    field: "authenticated",
    allowed: true,
    allowReason: "websocket query token accepted",
    denyReason: "websocket token missing or invalid",
  });
}

export function authenticateWebSocketUpgrade(input: {
  readonly request: Request;
  readonly publish: PublishPort;
  readonly token?: string;
  readonly onDecision?: ChannelAuthnDecisionObserver;
}): WebSocketAuthResult {
  const startedAt = Date.now();
  const state: WebSocketAuthState = {
    request: input.request,
    publish: input.publish,
    ...(input.token !== undefined ? { token: input.token } : {}),
  };
  const verdict = evaluateWebSocketToken(state);
  void recordDecision(WebSocketToken, verdict, Date.now() - startedAt, input.onDecision);

  return {
    verdict,
    ...(state.headers !== undefined ? { headers: state.headers } : {}),
    ...(state.response !== undefined ? { response: state.response } : {}),
  };
}
