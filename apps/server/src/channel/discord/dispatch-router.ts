import { Log } from "@openomni/session";
import { GatewayOp } from "./types";
import type { GatewayCallbacks } from "./gateway";
import type { GatewayPayload, DiscordUser } from "./types";

export interface DispatchState {
  sequence: number | null;
  sessionId: string | null;
  resumeUrl: string | null;
  reconnectAttempt: number;
}

export interface DispatchActions {
  sendGateway: (payload: Record<string, unknown>) => void;
  identify: () => void;
  startHeartbeat: (intervalMs: number) => void;
  closeSocket: (code?: number) => void;
  stopRunning: () => void;
  callbacks: GatewayCallbacks;
}

export function handleGatewayPayload(
  payload: GatewayPayload,
  state: DispatchState,
  actions: DispatchActions,
): boolean {
  if (payload.s !== null) state.sequence = payload.s;

  switch (payload.op) {
    case GatewayOp.HELLO: {
      const d = payload.d as { heartbeat_interval: number };
      actions.startHeartbeat(d.heartbeat_interval);
      if (state.sessionId && state.sequence !== null) {
        actions.sendGateway({
          op: GatewayOp.RESUME,
          d: { token: undefined, session_id: state.sessionId, seq: state.sequence },
        });
      } else {
        actions.identify();
      }
      return false;
    }
    case GatewayOp.HEARTBEAT_ACK:
      return false;
    case GatewayOp.RECONNECT:
      Log.info("discord server requested reconnect");
      actions.closeSocket(4000);
      return false;
    case GatewayOp.INVALID_SESSION: {
      const resumable = payload.d as boolean;
      Log.warn("discord invalid session", { resumable });
      if (!resumable) {
        state.sessionId = null;
        state.sequence = null;
      }
      actions.closeSocket(4000);
      return false;
    }
    case GatewayOp.DISPATCH:
      return payload.t ? handleDispatch(payload.t, payload.d, state, actions) : false;
    default:
      return false;
  }
}

function handleDispatch(
  event: string,
  data: unknown,
  state: DispatchState,
  actions: DispatchActions,
): boolean {
  if (event === "READY") {
    const d = data as { session_id: string; resume_gateway_url: string; user: DiscordUser };
    state.sessionId = d.session_id;
    state.resumeUrl = `${d.resume_gateway_url}?v=10&encoding=json`;
    state.reconnectAttempt = 0;
    actions.callbacks.onReady({ botId: d.user.id, botUsername: d.user.username });
    return true;
  }
  if (event === "RESUMED") {
    state.reconnectAttempt = 0;
    Log.info("discord session resumed");
    return true;
  }
  try {
    actions.callbacks.onDispatch(event, data);
  } catch (err) {
    Log.error("discord dispatch error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
  return false;
}
