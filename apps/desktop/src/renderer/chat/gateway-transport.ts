import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";

/** The subset of `WebSocket` this transport uses, so a test can serve its own. */
interface SocketLike {
  readonly readyState: number;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string | ArrayBuffer | Blob }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

/** A `WebSocket` constructor: the global one unless a caller injects another. */
type SocketConstructor = new (url: string, protocols?: string | string[]) => SocketLike;

interface GatewayChatTransportOptions {
  /** `ws://host:port` — the gateway's WebSocket endpoint. */
  readonly url: string;
  
  readonly protocols?: string | readonly string[];
  /** Injected in tests. Defaults to the platform `WebSocket`. */
  readonly WebSocketImpl?: SocketConstructor;
}

/** The three frames the gateway sends, once parsed. */
const serverFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("receipt"), status: z.literal("accepted") }),
  z.object({ type: z.literal("message"), messageId: z.string(), text: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

type ServerFrame = z.infer<typeof serverFrameSchema>;

function parseFrame(raw: string | ArrayBuffer | Blob): ServerFrame | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const result = serverFrameSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

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
  
  const pending: Turn[] = [];
  
  const outstanding = new Map<string, OutstandingMessage>();
  const lastChatId = new WeakMap<SocketLike, string>();

  function settle(source: SocketLike, frame: ServerFrame): void {
    if (frame.type === "receipt") return;
    if (frame.type === "message") {
      const chatId =
        pending.find((turn) => turn.socket === source)?.chatId ?? lastChatId.get(source);
      if (chatId !== undefined) {
        outstanding.set(chatId, { id: frame.messageId, socket: source });
      }
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

  const { closeSocket, connectUntilAborted } = createConnection(options, settle, drain);

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
      const replyToId = outstandingMessage?.socket === live ? outstandingMessage.id : undefined;
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
      let sent = false;
      try {
        live.send(JSON.stringify(replyToId === undefined ? { text } : { text, replyToId }));
        sent = true;
      } finally {
        if (!sent) closeSocket(live);
      }
      lastChatId.set(live, chatId);
      if (replyToId !== undefined) outstanding.delete(chatId);

      return stream;
    },

    reconnectToStream() {
      return Promise.resolve(null);
    },
  };
}

function createConnection(
  options: GatewayChatTransportOptions,
  settle: (source: SocketLike, frame: ServerFrame) => void,
  drain: (source: SocketLike, errorText?: string) => void,
) {
  const Socket: SocketConstructor = options.WebSocketImpl ?? globalThis.WebSocket;

  let socket: SocketLike | undefined;
  let opening: { readonly socket: SocketLike; readonly promise: Promise<SocketLike> } | undefined;
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
        : new Socket(
            options.url,
            typeof options.protocols === "string" ? options.protocols : [...options.protocols],
          );
    socket = next;
    next.addEventListener("message", (event) => {
      const frame = parseFrame(event.data);
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

  return { closeSocket, connectUntilAborted };
}
