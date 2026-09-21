import { z } from "zod";
import { Effect, type Context } from "effect";
import type { WebSocketFrames } from "./services";
import { decodeChannelFailure, InvalidInbound, type ChannelError } from "./errors";
import { newTraceId } from "./support/trace";
import { Channel, Gateway, Operational } from "@openomni/protocol";
import { authenticateWebSocketUpgrade } from "./authn/websocket";
import type { ChannelAuthnDecisionObserver } from "./authn/types";
import type { PublishPort } from "./types";

export type WebSocketMessageHandler = (
  message: Channel.InboundMessage,
) => Effect.Effect<void, ChannelError>;

export type WebSocketFrameOutcome =
  | { readonly type: "receipt"; readonly status: "accepted" }
  | { readonly type: "receipt"; readonly inputId: string; readonly result: Gateway.IngestResult };

export interface WebSocketConfig {
  token?: string;
  onAuthDecision?: ChannelAuthnDecisionObserver;
  /** Compose with the same gateway.ingest used by ordinary channel messages. */
  onRequestAnswer?: (
    sender: Gateway.IngestSender & { kind: "external" },
    answer: Gateway.RequestAnswer,
  ) => Effect.Effect<Gateway.IngestResult, ChannelError>;
}

export interface WsConnectionData {
  surfaceKey: string;
  authenticated: boolean;
  /** Declared actor address or a connection-local deliverable address. */
  externalId: string;
}

export interface WsConnection {
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

export class WebSocketHandler implements Context.Tag.Service<typeof WebSocketFrames> {
  /**
   * Live connections by declared externalId, last-wins: a reconnect replaces
   * the previous socket as the delivery target. Everyone on this socket is
   * already behind the owner-tier upgrade gate, so the declaration is an
   * address, not an authentication.
   */
  private readonly connections = new Map<string, WsConnection>();

  constructor(
    private readonly handler: WebSocketMessageHandler,
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
    const auth = authenticateWebSocketUpgrade({
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

  handleFrame(
    connection: WsConnectionData,
    data: string | Buffer,
  ): Effect.Effect<WebSocketFrameOutcome, ChannelError> {
    return Effect.gen(this, function* () {
      yield* Effect.try({
        try: () => this.publish(Operational.Events.Debug, {
          traceId: newTraceId(),
          time: Date.now(),
          component: "server",
          msg: "websocket message received",
          context: { surfaceKey: connection.surfaceKey },
        }),
        catch: decodeChannelFailure("websocket.observe"),
      });
      const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
      const parsed = yield* decodeFrame(raw);
      const sender = {
        kind: "external",
        surface: "ws",
        externalId: connection.externalId,
      } as const;
      if (parsed.kind === "request_answer") {
        if (this.config.onRequestAnswer === undefined) {
          return yield* new InvalidInbound({
            operation: "websocket.frame",
            reason: "request_answer_unavailable",
          });
        }
        const result = yield* this.config.onRequestAnswer(sender, parsed);
        return { type: "receipt", inputId: parsed.inputId, result };
      }
      yield* this.handler({
        sender,
        facts: {
          eventId: parsed.eventId ?? crypto.randomUUID(),
          surface: "ws",
          channelId: connection.surfaceKey,
          addressees: [],
          dm: true,
          ...(parsed.replyToId !== undefined ? { reply: { chain: [parsed.replyToId] } } : {}),
          payload: { websocket: { authenticated: connection.authenticated } },
          render: parsed.text,
        },
      });
      return { type: "receipt", status: "accepted" };
    });
  }
}

function decodeFrame(raw: string): Effect.Effect<z.infer<typeof WebSocketFrame>, InvalidInbound> {
  return Effect.gen(function* () {
    const document = yield* Effect.try({
      try: () => z.record(z.string(), z.json()).safeParse(JSON.parse(raw)),
      catch: decodeChannelFailure("websocket.decode"),
    }).pipe(Effect.mapError((failure) => new InvalidInbound({
      operation: "websocket.frame", reason: "invalid_json", cause: failure.cause,
    })));
    if (!document.success) {
      return yield* new InvalidInbound({ operation: "websocket.frame", reason: "invalid_frame" });
    }
    const frame = WebSocketFrame.safeParse(document.data);
    if (!frame.success) {
      return yield* new InvalidInbound({
        operation: "websocket.frame",
        reason: document.data.type === "request_answer" ? "invalid_request_answer" : "text_required",
      });
    }
    return frame.data;
  });
}
