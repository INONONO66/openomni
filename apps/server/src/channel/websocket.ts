import { newTraceId } from "@openomni/telemetry";
import type { Adapter } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { ChannelAuthnMiddleware, type ChannelAuthnDecisionObserver } from "./channel-authn";
import type { PublishPort } from "./types";

export interface WebSocketConfig {
  token?: string;
  onAuthDecision?: ChannelAuthnDecisionObserver;
}

interface WsConnectionData {
  surfaceKey: string;
  authenticated: boolean;
}

interface WebSocketUpgradeOptions {
  data: WsConnectionData;
  headers?: Record<string, string>;
}

export class WebSocketHandler {
  constructor(
    private readonly handler: Adapter.MessageHandler,
    private readonly publish: PublishPort,
    private readonly config: WebSocketConfig = {},
  ) {}

  get ws() {
    const self = this;
    return {
      message(ws: { data: WsConnectionData; send(msg: string): void }, data: string | Buffer) {
        const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
        self.publish(Operational.Debug, {
          traceId: newTraceId(),
          time: Date.now(),
          component: "server",
          msg: "websocket message received",
          context: { surfaceKey: ws.data.surfaceKey },
        });
        void self.handleMessage(ws, raw);
      },
      open(ws: { data: WsConnectionData }) {
        ws.data = {
          surfaceKey: ws.data.surfaceKey,
          authenticated: ws.data.authenticated,
        };
        self.publish(Operational.Info, {
          traceId: newTraceId(),
          time: Date.now(),
          component: "server",
          msg: "websocket connection opened",
          context: { surfaceKey: ws.data.surfaceKey },
        });
      },
      close(ws: { data: WsConnectionData }) {
        self.publish(Operational.Info, {
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

    const ok = server.upgrade(req, {
      data: { surfaceKey: `ws:${crypto.randomUUID()}`, authenticated } satisfies WsConnectionData,
      ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
    });
    if (ok) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  private async handleMessage(
    ws: { data: WsConnectionData; send(msg: string): void },
    raw: string,
  ): Promise<void> {
    try {
      const parsed = JSON.parse(raw) as { type?: string; text?: string; surfaceKey?: string };

      if (!parsed.text) {
        ws.send(JSON.stringify({ type: "error", message: "text field required" }));
        return;
      }

      const surfaceKey = ws.data.surfaceKey;

      const result = await this.handler({
        id: crypto.randomUUID(),
        surfaceKey,
        text: parsed.text,
        sender: { id: "ws", name: "WebSocket" },
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
