import type { Adapter } from "@openomni/protocol";

export interface WebSocketConfig {
  token?: string;
}

interface WsConnectionData {
  surfaceKey: string;
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
        void self.handleMessage(ws, raw);
      },
      open(ws: { data: WsConnectionData }) {
        ws.data = { surfaceKey: `ws:${crypto.randomUUID()}` };
      },
    };
  }

  handleUpgrade(
    req: Request,
    server: { upgrade(req: Request, options?: { data?: unknown }): boolean },
  ): Response | undefined {
    if (this.config.token) {
      const url = new URL(req.url);
      const provided = url.searchParams.get("token");
      if (provided !== this.config.token) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const ok = server.upgrade(req, {
      data: { surfaceKey: `ws:${crypto.randomUUID()}` } satisfies WsConnectionData,
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
