import { z } from "zod";
import { newTraceId } from "./support/trace";
import { Channel, Gateway, Operational } from "@openomni/protocol";
import { ChannelAuthnMiddleware, type ChannelAuthnDecisionObserver } from "./channel-authn";
import type { PublishPort } from "./types";

export interface WebSocketConfig {
  token?: string;
  onAuthDecision?: ChannelAuthnDecisionObserver;
  /** Compose with the same gateway.ingest used by ordinary channel messages. */
  onRequestAnswer?: (
    sender: Gateway.IngestSender & { kind: "external" },
    answer: Gateway.RequestAnswer,
  ) => Promise<Gateway.IngestResult>;
}

interface WsConnectionData {
  surfaceKey: string;
  authenticated: boolean;
  /** Declared actor address or a connection-local deliverable address. */
  externalId: string;
}

interface WsConnection {
  data: WsConnectionData;
  send(msg: string): void;
}

interface WebSocketUpgradeOptions {
  data: WsConnectionData;
}

const RequestAnswerFrame = Gateway.RequestAnswer.extend({
  type: z.literal("request_answer"),
  kind: z.json().optional(),
}).transform(
  (frame): Gateway.RequestAnswer => ({
    kind: "request_answer",
    inputId: frame.inputId,
    request: frame.request,
    decision: frame.decision,
    credential: frame.credential,
  }),
);
const TextFrame = z
  .object({
    type: z
      .json()
      .optional()
      .refine((type) => type !== "request_answer"),
    text: z.string().min(1),
    eventId: z.string().min(1).optional().catch(undefined),
    replyToId: z.string().min(1).optional().catch(undefined),
  })
  .transform((frame) => ({
    kind: "message" as const,
    text: frame.text,
    eventId: frame.eventId,
    replyToId: frame.replyToId,
  }));
const WebSocketFrame = z.union([RequestAnswerFrame, TextFrame]);

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
   * kernel re-key the request's correlation to it.
   */
  push(
    externalId: string,
    body: string,
    idempotencyKey: string,
  ): {
    value: "accepted";
    externalMessageId: string;
  } {
    const connection = this.connections.get(externalId);
    if (connection === undefined) {
      throw new Error(`no live websocket connection for actor ${externalId}`);
    }
    const messageId = idempotencyKey;
    connection.send(JSON.stringify({ type: "message", messageId, text: body }));
    return { value: "accepted", externalMessageId: messageId };
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
        void self.handleMessage(ws, raw);
      },
      open(ws: WsConnection) {
        self.connections.set(ws.data.externalId, ws);
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
        if (self.connections.get(externalId) === ws) {
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
    // (delegated instructions are pushed to it, its replies settle requests), so
    // it requires the shared token — unlike plain owner chat, which loopback
    // trust covers. On a tokenless bind the declaration is simply not taken.
    const declaredId = authenticated
      ? new URL(req.url).searchParams.get("actor")?.trim()
      : undefined;
    const externalId = declaredId || `connection:${crypto.randomUUID()}`;
    // Bun 1.3.6 writes an explicit response protocol twice. Narrow the offer
    // AFTER authentication so Bun negotiates only the selected, non-secret protocol.
    if (auth.protocol !== undefined) req.headers.set("sec-websocket-protocol", auth.protocol);
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
        externalId,
      } satisfies WsConnectionData,
    });
    if (ok) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  private async handleMessage(ws: WsConnection, raw: string): Promise<void> {
    try {
      const parsedResult = z.record(z.string(), z.json()).safeParse(JSON.parse(raw));
      if (!parsedResult.success) {
        ws.send(JSON.stringify({ type: "error", message: "invalid websocket frame" }));
        return;
      }
      const frame = WebSocketFrame.safeParse(parsedResult.data);
      if (!frame.success) {
        ws.send(
          JSON.stringify({
            type: "error",
            message:
              parsedResult.data.type === "request_answer"
                ? "invalid request_answer frame"
                : "text field required",
          }),
        );
        return;
      }
      const parsed = frame.data;
      const sender = {
        kind: "external",
        surface: "ws",
        externalId: ws.data.externalId,
      } as const;
      if (parsed.kind === "request_answer") {
        if (this.config.onRequestAnswer === undefined) {
          ws.send(JSON.stringify({ type: "error", message: "request_answer unavailable" }));
          return;
        }
        try {
          const result = await this.config.onRequestAnswer(sender, parsed);
          ws.send(JSON.stringify({ type: "receipt", inputId: parsed.inputId, result }));
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "request_answer failed" }));
        }
        return;
      }

      const surfaceKey = ws.data.surfaceKey;

      await this.handler({
        sender,
        facts: {
          eventId: parsed.eventId ?? crypto.randomUUID(),
          surface: "ws",
          channelId: surfaceKey,
          addressees: [],
          dm: true,
          ...(parsed.replyToId !== undefined ? { reply: { chain: [parsed.replyToId] } } : {}),
          payload: { websocket: { authenticated: ws.data.authenticated } },
          render: parsed.text,
        },
      });

      ws.send(JSON.stringify({ type: "receipt", status: "accepted" }));
    } catch {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "websocket message failed",
        }),
      );
    }
  }
}
