import type { Adapter } from "@openomni/protocol";
import { Log } from "@openomni/session";

export interface WebSocketConfig {
  token?: string;
}

interface WsConnectionData {
  surfaceKey: string;
}

interface WebSocketUpgradeOptions {
  data: WsConnectionData;
  headers?: Record<string, string>;
}

function readSubprotocolAuth(req: Request): { token: string; selected: string } | undefined {
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

export class WebSocketHandler {
  constructor(
    private readonly handler: Adapter.MessageHandler,
    private readonly config: WebSocketConfig = {},
  ) {}

  get ws() {
    const self = this;
    return {
      message(ws: { data: WsConnectionData; send(msg: string): void }, data: string | Buffer) {
        const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
        Log.debug("websocket message received", { surfaceKey: ws.data.surfaceKey });
        void self.handleMessage(ws, raw);
      },
      open(ws: { data: WsConnectionData }) {
        ws.data = { surfaceKey: `ws:${crypto.randomUUID()}` };
        Log.info("websocket connection opened", { surfaceKey: ws.data.surfaceKey });
      },
      close(ws: { data: WsConnectionData }) {
        Log.info("websocket connection closed", { surfaceKey: ws.data.surfaceKey });
      },
    };
  }

  handleUpgrade(
    req: Request,
    server: { upgrade(req: Request, options: WebSocketUpgradeOptions): boolean },
  ): Response | undefined {
    let headers: Record<string, string> | undefined;

    if (this.config.token) {
      const url = new URL(req.url);
      const subprotocolAuth = readSubprotocolAuth(req);
      const provided = subprotocolAuth?.token ?? url.searchParams.get("token");
      if (provided !== this.config.token) {
        Log.warn("websocket auth failure");
        return new Response("Unauthorized", { status: 401 });
      }

      if (subprotocolAuth) {
        headers = { "Sec-WebSocket-Protocol": subprotocolAuth.selected };
      } else {
        Log.warn("websocket query token auth is deprecated");
      }
    }

    const ok = server.upgrade(req, {
      data: { surfaceKey: `ws:${crypto.randomUUID()}` } satisfies WsConnectionData,
      headers,
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
