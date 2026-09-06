import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

/**
 * The openomni gateway, spoken as an AI SDK `ChatTransport`.
 *
 * The SDK's default transport is HTTP-shaped: one request, one SSE body, one
 * connection per turn. The gateway is neither — it is a single long-lived socket
 * carrying frames in both directions, and a turn is a `response` frame that
 * arrives on a connection opened long before the turn existed. So the adapter
 * lives here rather than in a `fetch` shim: what has to be translated is the
 * SHAPE of the conversation, not its transport headers.
 *
 * ## What this file owns, and what it must not
 *
 * It owns the wire — the three server frames, the reply correlation, and the
 * socket's lifecycle. It owns NO presentation: it emits chunks and the SDK
 * reduces them into messages. `@openomni/ui` never learns that any of this
 * exists, which is the same boundary the rest of the renderer keeps.
 *
 * ## Why one socket, opened late
 *
 * The gateway may demand a token through the WebSocket subprotocol, and the
 * surface that holds tokens is the app, not this module. Opening lazily means a
 * transport can be constructed before a token is known and still connect with
 * one; keeping ONE socket per transport means a Wait pushed as a `message`
 * frame and the reply that settles it travel the same connection, which is what
 * makes `replyToId` correlation meaningful at all.
 */

/** The subset of `WebSocket` this transport uses, so a test can serve its own. */
interface SocketLike {
  readonly readyState: number;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

/** A `WebSocket` constructor: the global one unless a caller injects another. */
type SocketConstructor = new (url: string, protocols?: string | readonly string[]) => SocketLike;

interface GatewayChatTransportOptions {
  /** `ws://host:port` — the gateway's WebSocket endpoint. */
  readonly url: string;
  /**
   * Sec-WebSocket-Protocol offers, passed through untouched.
   *
   * The gateway carries its bearer token here. This module deliberately does no
   * auth of its own: it neither reads the token nor decides when one is needed,
   * because both answers belong to whoever configured the endpoint.
   */
  readonly protocols?: string | readonly string[];
  /** Injected in tests. Defaults to the platform `WebSocket`. */
  readonly WebSocketImpl?: SocketConstructor;
}

/** The three frames the gateway sends, once parsed. */
type ServerFrame =
  | { readonly type: "response"; readonly text: string }
  | { readonly type: "message"; readonly messageId: string }
  | { readonly type: "error"; readonly message: string };

/**
 * Parse a raw frame into one of the three known shapes.
 *
 * Anything else — an unknown `type`, a `response` with no text, a non-object —
 * is `undefined` and simply ignored. A gateway that grows a fourth frame must
 * not break a client that has not learned it yet, and the SDK has no chunk that
 * means "something arrived and I could not read it".
 */
function parseFrame(raw: unknown): ServerFrame | undefined {
  if (typeof raw !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const frame: Record<string, unknown> = { ...value };
  const type = frame.type;
  if (type === "response") {
    return typeof frame.text === "string" ? { type: "response", text: frame.text } : undefined;
  }
  if (type === "message") {
    return typeof frame.messageId === "string"
      ? { type: "message", messageId: frame.messageId }
      : undefined;
  }
  if (type === "error") {
    return typeof frame.message === "string"
      ? { type: "error", message: frame.message }
      : undefined;
  }
  return undefined;
}

/**
 * The prompt as the gateway wants it: the last user turn's text, flattened.
 *
 * Only the LAST user message is sent because the gateway keeps the ledger. The
 * SDK hands over the whole history on every turn; replaying it would append the
 * conversation to itself on the server side.
 */
function lastUserText(messages: readonly UIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
}

/** A turn awaiting its terminal frame. */
interface Turn {
  readonly chatId: string;
  readonly socket: SocketLike;
  readonly emit: (chunk: UIMessageChunk) => void;
  readonly close: () => void;
}

interface OutstandingMessage {
  readonly id: string;
  readonly socket: SocketLike;
}

interface SocketConnection {
  readonly socket: SocketLike;
  readonly opened: Promise<SocketLike>;
}

function emptyStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

export function createGatewayChatTransport(
  options: GatewayChatTransportOptions,
): ChatTransport<UIMessage> {
  const Socket: SocketConstructor =
    options.WebSocketImpl ?? (globalThis.WebSocket as unknown as SocketConstructor);

  let socket: SocketLike | undefined;
  let opening:
    | { readonly socket: SocketLike; readonly promise: Promise<SocketLike> }
    | undefined;
  /**
   * Turns in flight, oldest first. The gateway answers in order on one socket,
   * so the next terminal frame belongs to the head of this queue — which also
   * means a turn is never resolved by another turn's frame.
   */
  const pending: Turn[] = [];
  /**
   * The unanswered Wait, per chat. A `message` frame is the gateway asking, and
   * the answer is only an answer if it names the question.
   */
  const outstanding = new Map<string, OutstandingMessage>();
  const lastChatId = new WeakMap<SocketLike, string>();

  function settle(source: SocketLike, frame: ServerFrame): void {
    if (frame.type === "message") {
      const chatId = pending.find((turn) => turn.socket === source)?.chatId ?? lastChatId.get(source);
      if (chatId !== undefined) {
        outstanding.set(chatId, { id: frame.messageId, socket: source });
      }
      return;
    }
    const index = pending.findIndex((turn) => turn.socket === source);
    if (index < 0) return;
    const [turn] = pending.splice(index, 1);
    if (turn === undefined) return;
    if (frame.type === "error") {
      turn.emit({ type: "error", errorText: frame.message });
      turn.close();
      return;
    }
    const id = crypto.randomUUID();
    turn.emit({ type: "start" });
    turn.emit({ type: "text-start", id });
    turn.emit({ type: "text-delta", id, delta: frame.text });
    turn.emit({ type: "text-end", id });
    turn.emit({ type: "finish" });
    turn.close();
  }

  /** Every in-flight turn on one socket ends when that socket does. */
  function drain(source: SocketLike, errorText?: string): void {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const turn = pending[index];
      if (turn?.socket !== source) continue;
      pending.splice(index, 1);
      if (errorText !== undefined) turn.emit({ type: "error", errorText });
      turn.close();
    }
    for (const [chatId, message] of outstanding) {
      if (message.socket === source) outstanding.delete(chatId);
    }
  }

  function closeSocket(source: SocketLike, errorText?: string): void {
    if (socket === source) socket = undefined;
    drain(source, errorText);
    source.close();
  }

  function connect(): SocketConnection {
    const live = socket;
    if (live !== undefined && (live.readyState === 0 || live.readyState === 1)) {
      return {
        socket: live,
        opened: opening?.socket === live ? opening.promise : Promise.resolve(live),
      };
    }
    const next =
      options.protocols === undefined
        ? new Socket(options.url)
        : new Socket(options.url, options.protocols);
    socket = next;
    next.addEventListener("message", (event) => {
      const frame = parseFrame(typeof event.data === "string" ? event.data : String(event.data));
      if (frame !== undefined) settle(next, frame);
    });
    next.addEventListener("close", () => {
      if (socket === next) socket = undefined;
      if (opening?.socket === next) opening = undefined;
      drain(next, "gateway socket closed unexpectedly");
    });
    next.addEventListener("error", () =>
      closeSocket(next, `gateway socket failed: ${options.url}`),
    );
    let settled = false;
    const promise = new Promise<SocketLike>((resolve, reject) => {
      next.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        if (opening?.socket === next) opening = undefined;
        resolve(next);
      });
      next.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        if (opening?.socket === next) opening = undefined;
        reject(new Error(`gateway socket failed: ${options.url}`));
      });
      next.addEventListener("close", () => {
        if (settled) return;
        settled = true;
        reject(new Error(`gateway socket closed before opening: ${options.url}`));
      });
    });
    opening = { socket: next, promise };
    return { socket: next, opened: promise };
  }

  async function connectUntilAborted(
    abortSignal: AbortSignal | undefined,
  ): Promise<SocketLike | undefined> {
    const connection = connect();
    if (abortSignal === undefined) return connection.opened;

    let settleAbort: (() => void) | undefined;
    const aborted = new Promise<undefined>((resolve) => {
      settleAbort = () => resolve(undefined);
    });
    const abort = () => {
      settleAbort?.();
      closeSocket(connection.socket);
    };
    abortSignal.addEventListener("abort", abort, { once: true });
    if (abortSignal.aborted) abort();

    try {
      return await Promise.race([connection.opened, aborted]);
    } finally {
      abortSignal.removeEventListener("abort", abort);
    }
  }

  return {
    async sendMessages({ trigger, chatId, messages, abortSignal }) {
      if (trigger === "regenerate-message") {
        throw new Error("gateway transport does not support regeneration");
      }
      if (abortSignal?.aborted) return emptyStream();

      const text = lastUserText(messages);
      const live = await connectUntilAborted(abortSignal);
      if (live === undefined) return emptyStream();

      const outstandingMessage = outstanding.get(chatId);
      const replyToId =
        outstandingMessage?.socket === live ? outstandingMessage.id : undefined;
      if (outstandingMessage !== undefined && outstandingMessage.socket !== live) {
        outstanding.delete(chatId);
      }

      let controller: ReadableStreamDefaultController<UIMessageChunk> | undefined;
      let closed = false;
      let removeAbortListener: (() => void) | undefined;
      const turn: Turn = {
        chatId,
        socket: live,
        emit: (chunk) => controller?.enqueue(chunk),
        close: () => {
          if (closed) return;
          closed = true;
          removeAbortListener?.();
          controller?.close();
        },
      };

      const stopTurn = () => {
        const index = pending.indexOf(turn);
        if (index >= 0) pending.splice(index, 1);
        turn.close();
        closeSocket(live, "gateway socket closed by another turn");
      };

      const stream = new ReadableStream<UIMessageChunk>({
        start(streamController) {
          controller = streamController;
        },
        cancel() {
          if (closed) return;
          closed = true;
          removeAbortListener?.();
          const index = pending.indexOf(turn);
          if (index >= 0) pending.splice(index, 1);
          closeSocket(live, "gateway socket closed by another turn");
        },
      });

      const abort = () => stopTurn();
      removeAbortListener = () => abortSignal?.removeEventListener("abort", abort);
      abortSignal?.addEventListener("abort", abort, { once: true });
      if (abortSignal?.aborted) {
        abort();
        return stream;
      }

      pending.push(turn);
      try {
        live.send(JSON.stringify(replyToId === undefined ? { text } : { text, replyToId }));
      } catch (error) {
        closeSocket(live);
        throw error;
      }
      lastChatId.set(live, chatId);
      if (replyToId !== undefined) outstanding.delete(chatId);

      return stream;
    },

    // The gateway has no resumable stream: a turn's `response` is one frame on a
    // socket, so there is nothing to reconnect TO. Answering `null` is the SDK's
    // contract for "no active stream", not a stub.
    reconnectToStream() {
      return Promise.resolve(null);
    },
  };
}
