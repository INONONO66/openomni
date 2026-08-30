import { Channel, newTraceId, Operational } from "@openomni/protocol";
import { ChannelAuthnMiddleware, type ChannelAuthnDecisionObserver } from "./channel-authn";
import type { PublishPort } from "./types";

export interface WebSocketConfig {
  token?: string;
  onAuthDecision?: ChannelAuthnDecisionObserver;
}

interface WsConnectionData {
  surfaceKey: string;
  authenticated: boolean;
  /** Present when the connection declared who it is (`?actor=<externalId>`). */
  externalId?: string;
}

interface WsConnection {
  data: WsConnectionData;
  send(msg: string): void;
}

interface WebSocketUpgradeOptions {
  data: WsConnectionData;
  headers?: Record<string, string>;
}

export class WebSocketHandler {
  /**
   * Live connections by declared externalId, last-wins: a reconnect replaces
   * the previous socket as the delivery target. Everyone on this socket is
   * already behind the owner-tier upgrade gate, so the declaration is an
   * address, not an authentication.
   */
  private readonly connections = new Map<string, WsConnection>();

  constructor(
    private readonly handler: Channel.MessageHandler,
    private readonly publish: PublishPort,
    private readonly config: WebSocketConfig = {},
  ) {}

  /**
   * Outbound delivery to a declared connection. Mints the platform message id
   * the client must echo back as `replyToId` — returning it lets the send
   * kernel re-key the Wait's correlation to it.
   */
  push(externalId: string, body: string): { externalMessageId: string } {
    const connection = this.connections.get(externalId);
    if (connection === undefined) {
      throw new Error(`no live websocket connection for actor ${externalId}`);
    }
    const messageId = crypto.randomUUID();
    connection.send(JSON.stringify({ type: "message", messageId, text: body }));
    return { externalMessageId: messageId };
  }

  get ws() {
    const self = this;
    return {
      message(ws: WsConnection, data: string | Buffer) {
        const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
        // Origin: the first frame of an inbound websocket message — this ONE
        // mint is the message's trace, carried to the run (D11).
        const traceId = newTraceId();
        self.publish(Operational.Events.Debug, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: "websocket message received",
          context: { surfaceKey: ws.data.surfaceKey },
        });
        void self.handleMessage(ws, raw, traceId);
      },
      open(ws: WsConnection) {
        if (ws.data.externalId !== undefined) {
          self.connections.set(ws.data.externalId, ws);
        }
        self.publish(Operational.Events.Info, {
          traceId: newTraceId(),
          time: Date.now(),
          component: "server",
          msg: "websocket connection opened",
          context: { surfaceKey: ws.data.surfaceKey },
        });
      },
      close(ws: WsConnection) {
        const externalId = ws.data.externalId;
        if (externalId !== undefined && self.connections.get(externalId) === ws) {
          self.connections.delete(externalId);
        }
        self.publish(Operational.Events.Info, {
          traceId: newTraceId(),
          time: Date.now(),
          component: "server",
          msg: "websocket connection closed",
          context: { surfaceKey: ws.data.surfaceKey },
        });
      },
    };
  }

  handleUpgrade(
    req: Request,
    server: { upgrade(req: Request, options: WebSocketUpgradeOptions): boolean },
  ): Response | undefined {
    const auth = ChannelAuthnMiddleware.authenticateWebSocketUpgrade({
      request: req,
      publish: this.publish,
      ...(this.config.token !== undefined ? { token: this.config.token } : {}),
      ...(this.config.onAuthDecision !== undefined
        ? { onDecision: this.config.onAuthDecision }
        : {}),
    });
    if (auth.response) return auth.response;
    const hasConfiguredToken = this.config.token !== undefined && this.config.token.length > 0;
    const authenticated = hasConfiguredToken && auth.verdict.verdict === "allow";

    // An actor declaration binds this connection to a registered identity
    // (delegated instructions are pushed to it, its replies settle Waits), so
    // it requires the shared token — unlike plain owner chat, which loopback
    // trust covers. On a tokenless bind the declaration is simply not taken.
    const externalId = authenticated
      ? new URL(req.url).searchParams.get("actor")?.trim()
      : undefined;
    const ok = server.upgrade(req, {
      // `ws::dm:<uuid>` — empty namespace, so no workspace is derived and
      // actor endpoints registered as plain channel "ws" resolve.
      data: {
        surfaceKey: Channel.SurfaceKey.fromChannel({
          surface: "ws",
          namespace: "",
          kind: "dm",
          id: crypto.randomUUID(),
        }),
        authenticated,
        ...(externalId ? { externalId } : {}),
      } satisfies WsConnectionData,
      ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
    });
    if (ok) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  private async handleMessage(ws: WsConnection, raw: string, traceId: string): Promise<void> {
    try {
      const parsed = JSON.parse(raw) as {
        type?: string;
        text?: string;
        replyToId?: string;
      };

      if (!parsed.text) {
        ws.send(JSON.stringify({ type: "error", message: "text field required" }));
        return;
      }

      const surfaceKey = ws.data.surfaceKey;

      const result = await this.handler({
        id: crypto.randomUUID(),
        traceId,
        surfaceKey,
        text: parsed.text,
        sender: { id: ws.data.externalId ?? "ws", name: ws.data.externalId ?? "WebSocket" },
        ...(typeof parsed.replyToId === "string" && parsed.replyToId.length > 0
          ? { replyToId: parsed.replyToId }
          : {}),
        raw: { websocket: { authenticated: ws.data.authenticated } },
      });

      ws.send(JSON.stringify({ type: "response", text: result?.text ?? "" }));
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
