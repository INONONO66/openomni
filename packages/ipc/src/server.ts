import { Ipc } from "@openomni/protocol";
import fs from "node:fs";

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
) => void;

export interface IpcServer {
  readonly socketPath: string;
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  useConnection(id: string): void;
  close(): void;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  connectionId: string;
};

export function createIpcServer(socketPath: string, handler: RequestHandler): IpcServer {
  // Remove stale socket file so Bun.listen doesn't fail with EADDRINUSE.
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  interface SocketData {
    id: string;
  }

  interface BunSocket {
    data: SocketData;
    write(data: Buffer | Uint8Array | string): number;
  }

  function setConnectionId(socket: BunSocket, id: string): void {
    socket.data = { id } satisfies SocketData;
  }

  function connectionId(socket: BunSocket): string {
    return socket.data.id;
  }

  const connections = new Map<string, { socket: BunSocket; decoder: LineDecoder }>();
  const pending = new Map<string, PendingRequest>();
  let connCounter = 0;
  let activeConnectionId: string | undefined;

  function getActiveSocket(): BunSocket | undefined {
    if (activeConnectionId) {
      const active = connections.get(activeConnectionId)?.socket;
      if (active) return active;
      return undefined;
    }
    const first = connections.values().next();
    return first.done ? undefined : first.value.socket;
  }

  function removeConnection(id: string, reason: string): void {
    connections.delete(id);
    if (id === activeConnectionId) {
      // Clear the pin: leaving it set to a now-dead connection wedges
      // getActiveSocket() (it resolves the stale id, finds nothing, and never
      // falls through to a surviving connection), so no next connection binds.
      activeConnectionId = undefined;
    }
    // A dead connection fails ITS in-flight requests as a connection loss —
    // leaving them to age out would misreport the failure as a timeout.
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
        setConnectionId(socket, id);
        connections.set(id, { socket, decoder: new LineDecoder() });
      },
      data(socket: BunSocket, raw: Buffer) {
        const state = connections.get(connectionId(socket));
        if (!state) return;

        let messages: unknown[];
        let malformed: string[];
        try {
          ({ frames: messages, malformed } = state.decoder.push(raw));
        } catch (error) {
          // Oversize line/buffer — the decoder already reset its buffer (DoS guard).
          socket.write(
            encode(
              Ipc.createErrorResponse(
                "unknown",
                4001,
                error instanceof Error ? error.message : "invalid IPC frame",
              ),
            ),
          );
          return;
        }

        for (const msg of messages) {
          let parsed: Ipc.Request | Ipc.Response | Ipc.Notification;
          try {
            parsed = decodeMessage(msg);
          } catch (err) {
            if (err instanceof IpcProtocolError) {
              const errResponse = Ipc.createErrorResponse("unknown", 4000, err.message);
              socket.write(encode(errResponse));
            }
            continue;
          }

          if (parsed.type === "response") {
            const handler = pending.get(parsed.id);
            if (handler) {
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
              socket.write(encode(Ipc.createResponse(parsed.id, result)));
            };
            const notify = (method: string, params?: Record<string, unknown>) => {
              socket.write(encode(Ipc.createNotification(method, params)));
            };
            try {
              handler(parsed.method, parsed.params, respond, notify, connectionId(socket));
            } catch (err) {
              socket.write(
                encode(
                  Ipc.createErrorResponse(
                    parsed.id,
                    1000,
                    err instanceof Error ? err.message : String(err),
                  ),
                ),
              );
            }
          } else if (parsed.type === "notification") {
            // notifications don't get error responses per the protocol spec
            try {
              handler(
                parsed.method,
                parsed.params,
                () => undefined,
                () => undefined,
                connectionId(socket),
              );
            } catch (error) {
              console.warn(
                "IPC notification handler failed:",
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }

        // A malformed line costs only itself: every parseable frame above was
        // already processed; each bad line gets its own 4001 error frame and
        // the connection survives.
        for (const line of malformed) {
          socket.write(
            encode(
              Ipc.createErrorResponse("unknown", 4001, `IPC frame is not valid JSON: ${line}`),
            ),
          );
        }
      },
      close(socket: BunSocket) {
        const id = connectionId(socket);
        removeConnection(id, "socket closed");
      },
      error(socket: BunSocket, _err: Error) {
        removeConnection(connectionId(socket), "socket error");
      },
    },
  });

  return {
    socketPath,
    call(method, params, timeoutMs = 30_000) {
      const sock = getActiveSocket();
      if (!sock) {
        return Promise.reject(new IpcConnectionError("no connected client"));
      }
      return new Promise((res, rej) => {
        const req = Ipc.createRequest(method, params);
        const timer = setTimeout(() => {
          pending.delete(req.id);
          rej(new IpcTimeoutError(`request timeout: ${method}`));
        }, timeoutMs);
        pending.set(req.id, { resolve: res, reject: rej, timer, connectionId: connectionId(sock) });
        sock.write(encode(req));
      });
    },
    notify(method, params) {
      const sock = getActiveSocket();
      if (sock) {
        sock.write(encode(Ipc.createNotification(method, params)));
      }
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

function decodeMessage(raw: unknown): IpcMessage {
  const req = Ipc.Request.safeParse(raw);
  if (req.success) return req.data;

  const res = Ipc.Response.safeParse(raw);
  if (res.success) return res.data;

  const notif = Ipc.Notification.safeParse(raw);
  if (notif.success) return notif.data;

  throw new IpcProtocolError(`Unknown message type: ${JSON.stringify(raw)}`);
}
