import fs from "node:fs";
import net from "node:net";
import { Ipc } from "@openomni/protocol";

import { IpcConnectionError, IpcProtocolError, IpcRemoteError, IpcTimeoutError } from "./errors";
import { LineDecoder, encode } from "./framing";

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

type RequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
  respond: (result: unknown) => void,
  notify: (method: string, params?: Record<string, unknown>) => void,
  connectionId: string,
) => void | Promise<void>;

export interface IpcServer {
  readonly socketPath: string;
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Returns false when the notification was dropped because no client is connected. */
  notify(method: string, params?: Record<string, unknown>): boolean;
  useConnection(id: string): void;
  close(): void;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  connectionId: string;
};

// How long the pre-listen probe waits for the existing socket to answer
// before concluding it is dead. No answer means "assume live": stealing a
// live server's socket wedges BOTH servers, so ambiguity resolves to refusal.
const SOCKET_PROBE_TIMEOUT_MS = 500;

/**
 * True when something accepts connections on `socketPath`. Connection refused
 * (or any other connect error) means the socket file is a stale leftover.
 */
function probeSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    let settled = false;
    const settle = (live: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => settle(true), SOCKET_PROBE_TIMEOUT_MS);
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
  });
}

export async function createIpcServer(
  socketPath: string,
  handler: RequestHandler,
): Promise<IpcServer> {
  // A leftover socket file blocks Bun.listen with EADDRINUSE — but blindly
  // unlinking would steal a LIVE server's socket (new connections silently
  // divert to the newcomer while the old server keeps running blind). Probe
  // first; only a provably dead socket file is removed.
  if (fs.existsSync(socketPath)) {
    if (await probeSocketLive(socketPath)) {
      throw new IpcConnectionError(`socket ${socketPath} is in use by a live server`);
    }
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  interface SocketData {
    id: string;
  }

  interface BunSocket {
    data: SocketData | undefined;
    write(data: Buffer | Uint8Array | string): number;
    end(): void;
  }

  function connectionIdOf(socket: BunSocket): string | undefined {
    return socket.data?.id;
  }

  type ConnectionState = {
    id: string;
    socket: BunSocket;
    decoder: LineDecoder;
    /**
     * Bytes the kernel did not accept yet. Bun sockets do NOT buffer partial
     * writes (unlike node:net) — whatever `socket.write` returns short must
     * be kept here and flushed on `drain`, or the frame is silently
     * truncated and the NDJSON stream desyncs.
     */
    writeQueue: Uint8Array[];
    /** Close the socket once every queued byte flushed (protocol desync). */
    endAfterFlush: boolean;
    /** The socket is gone; drop writes instead of queueing them forever. */
    closed: boolean;
  };

  const connections = new Map<string, ConnectionState>();
  const pending = new Map<string, PendingRequest>();
  let connCounter = 0;
  let activeConnectionId: string | undefined;

  function send(state: ConnectionState, bytes: Uint8Array): void {
    if (state.closed) return;
    if (state.writeQueue.length > 0) {
      // Earlier bytes are still waiting for drain — writing now would
      // interleave into the middle of a queued frame.
      state.writeQueue.push(bytes);
      return;
    }
    const written = state.socket.write(bytes);
    if (written < bytes.length) {
      state.writeQueue.push(written > 0 ? bytes.subarray(written) : bytes);
    }
  }

  function sendFrame(state: ConnectionState, msg: unknown): void {
    send(state, encode(msg));
  }

  function flushQueued(state: ConnectionState): void {
    if (state.closed) return;
    while (state.writeQueue.length > 0) {
      const chunk = state.writeQueue[0] as Uint8Array;
      const written = state.socket.write(chunk);
      if (written < chunk.length) {
        if (written > 0) state.writeQueue[0] = chunk.subarray(written);
        return; // kernel buffer full again — wait for the next drain
      }
      state.writeQueue.shift();
    }
    if (state.endAfterFlush) state.socket.end();
  }

  /**
   * Close once every queued byte flushed. end() half-closes: the already
   * flushed error frame reaches the peer with the FIN behind it, and Bun
   * fires this side's close handler (which releases the connection state and
   * fails its pendings). The IpcClient tears down on that FIN; a foreign
   * peer stuck mid-flood only strands its own socket, not the server's.
   */
  function closeAfterFlush(state: ConnectionState): void {
    state.endAfterFlush = true;
    if (state.writeQueue.length === 0 && !state.closed) state.socket.end();
  }

  function getActiveConnection(): ConnectionState | undefined {
    if (activeConnectionId) {
      return connections.get(activeConnectionId);
    }
    const first = connections.values().next();
    return first.done ? undefined : first.value;
  }

  function removeConnection(id: string, reason: string): void {
    const state = connections.get(id);
    if (state) state.closed = true;
    connections.delete(id);
    if (id === activeConnectionId) {
      // Clear the pin: leaving it set to a now-dead connection wedges
      // getActiveConnection() (it resolves the stale id, finds nothing, and
      // never falls through to a surviving connection), so no next
      // connection binds.
      activeConnectionId = undefined;
    }
    // A dead connection fails ITS in-flight requests as a connection loss —
    // leaving them to age out would misreport the failure as a timeout. This
    // includes requests whose bytes were still sitting in the write queue.
    failPendingOf(id, new IpcConnectionError(reason));
  }

  function failPendingOf(connId: string, err: Error): void {
    for (const [reqId, handler] of pending) {
      if (handler.connectionId !== connId) continue;
      clearTimeout(handler.timer);
      pending.delete(reqId);
      handler.reject(err);
    }
  }

  function failAllPending(err: Error): void {
    for (const [, handler] of pending) {
      clearTimeout(handler.timer);
      handler.reject(err);
    }
    pending.clear();
  }

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket: BunSocket) {
        const id = `conn-${++connCounter}`;
        socket.data = { id } satisfies SocketData;
        connections.set(id, {
          id,
          socket,
          decoder: new LineDecoder(),
          writeQueue: [],
          endAfterFlush: false,
          closed: false,
        });
      },
      data(socket: BunSocket, raw: Buffer) {
        const connId = connectionIdOf(socket);
        const state = connId === undefined ? undefined : connections.get(connId);
        if (!state) return;
        // A condemned connection's remaining inbound flood is dropped without
        // decoding: re-buffering megabytes of garbage per chunk pins the event
        // loop (and the reclaim timer with it) for nothing.
        if (state.endAfterFlush) return;

        let messages: unknown[];
        let malformed: string[];
        try {
          ({ frames: messages, malformed } = state.decoder.push(raw));
        } catch (error) {
          // Oversize line/buffer — the decoder already reset its buffer (DoS
          // guard). The reset happened MID-frame, so whatever arrives next is
          // an unparseable tail: answer 4001, then close the connection. The
          // client destroys its socket on protocol errors already; the server
          // is symmetric instead of keeping a desynced stream alive.
          sendFrame(
            state,
            Ipc.createErrorResponse(
              "unknown",
              4001,
              error instanceof Error ? error.message : "invalid IPC frame",
            ),
          );
          closeAfterFlush(state);
          return;
        }

        for (const msg of messages) {
          let parsed: Ipc.Request | Ipc.Response | Ipc.Notification;
          try {
            parsed = decodeMessage(msg);
          } catch (err) {
            if (err instanceof IpcProtocolError) {
              // Echo the offending frame's own id when it carries one, so the
              // requester's pending settles now instead of burning its
              // timeout. "unknown" is reserved for frames without one.
              const errResponse = Ipc.createErrorResponse(extractFrameId(msg), 4000, err.message);
              sendFrame(state, errResponse);
            }
            continue;
          }

          if (parsed.type === "response") {
            const handler = pending.get(parsed.id);
            // Response matching is scoped to the connection that owns the
            // request: another connection echoing (or guessing) the id must
            // not settle a pending it was never asked about.
            if (handler && handler.connectionId === state.id) {
              clearTimeout(handler.timer);
              pending.delete(parsed.id);
              if (parsed.error) {
                handler.reject(new IpcRemoteError(parsed.error.code, parsed.error.message));
              } else {
                handler.resolve(parsed.result);
              }
            }
          } else if (parsed.type === "request") {
            const respond = (result: unknown) => {
              sendFrame(state, Ipc.createResponse(parsed.id, result));
            };
            const notify = (method: string, params?: Record<string, unknown>) => {
              sendFrame(state, Ipc.createNotification(method, params));
            };
            const failRequest = (err: unknown) => {
              sendFrame(
                state,
                Ipc.createErrorResponse(
                  parsed.id,
                  1000,
                  err instanceof Error ? err.message : String(err),
                ),
              );
            };
            // Both sync throws AND async rejections become the typed code-1000
            // error frame — an escaping rejection would leave the requester
            // burning its timeout with no error response.
            try {
              const result = handler(parsed.method, parsed.params, respond, notify, state.id);
              if (result instanceof Promise) result.catch(failRequest);
            } catch (err) {
              failRequest(err);
            }
          } else if (parsed.type === "notification") {
            // notifications don't get error responses per the protocol spec
            const warnFailure = (error: unknown) => {
              console.warn(
                "IPC notification handler failed:",
                error instanceof Error ? error.message : String(error),
              );
            };
            try {
              const result = handler(
                parsed.method,
                parsed.params,
                () => undefined,
                () => undefined,
                state.id,
              );
              if (result instanceof Promise) result.catch(warnFailure);
            } catch (error) {
              warnFailure(error);
            }
          }
        }

        // A malformed line costs only itself: every parseable frame above was
        // already processed; each bad line gets its own 4001 error frame and
        // the connection survives. Non-JSON lines have no recoverable id.
        for (const line of malformed) {
          sendFrame(
            state,
            Ipc.createErrorResponse("unknown", 4001, `IPC frame is not valid JSON: ${line}`),
          );
        }
      },
      drain(socket: BunSocket) {
        const connId = connectionIdOf(socket);
        const state = connId === undefined ? undefined : connections.get(connId);
        if (state) flushQueued(state);
      },
      close(socket: BunSocket) {
        // The connection may die before `open` assigned socket.data.
        const id = connectionIdOf(socket);
        if (id !== undefined) removeConnection(id, "socket closed");
      },
      error(socket: BunSocket, _err: Error) {
        // The connection may error before `open` assigned socket.data.
        const id = connectionIdOf(socket);
        if (id !== undefined) removeConnection(id, "socket error");
      },
    },
  });

  return {
    socketPath,
    call(method, params, timeoutMs = 30_000) {
      const conn = getActiveConnection();
      if (!conn) {
        return Promise.reject(new IpcConnectionError("no connected client"));
      }
      return new Promise((res, rej) => {
        const req = Ipc.createRequest(method, params);
        const timer = setTimeout(() => {
          pending.delete(req.id);
          rej(new IpcTimeoutError(`request timeout: ${method}`));
        }, timeoutMs);
        pending.set(req.id, { resolve: res, reject: rej, timer, connectionId: conn.id });
        sendFrame(conn, req);
      });
    },
    notify(method, params) {
      const conn = getActiveConnection();
      if (!conn) return false;
      sendFrame(conn, Ipc.createNotification(method, params));
      return true;
    },
    useConnection(id) {
      if (connections.has(id)) activeConnectionId = id;
    },
    close() {
      failAllPending(new IpcConnectionError("server closed"));
      server.stop(true);
      try {
        fs.unlinkSync(socketPath);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    },
  };
}

// merged from codec.ts (#453 hygiene: sub-30-LOC single-importer)

type IpcMessage = Ipc.Request | Ipc.Response | Ipc.Notification;

// Cap how much of an unrecognized payload the error message echoes back.
const MAX_ERROR_PAYLOAD_CHARS = 200;

function decodeMessage(raw: unknown): IpcMessage {
  const req = Ipc.Request.safeParse(raw);
  if (req.success) return req.data;

  const res = Ipc.Response.safeParse(raw);
  if (res.success) return res.data;

  const notif = Ipc.Notification.safeParse(raw);
  if (notif.success) return notif.data;

  throw new IpcProtocolError(
    `Unknown message type: ${String(JSON.stringify(raw)).slice(0, MAX_ERROR_PAYLOAD_CHARS)}`,
  );
}

/** The offending frame's own id when it carries a string one, else "unknown". */
function extractFrameId(raw: unknown): string {
  if (raw !== null && typeof raw === "object" && "id" in raw) {
    const id = (raw as { id: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "unknown";
}
