import { Ipc } from "@openomni/protocol";
import fs from "node:fs";

import { IpcConnectionError, IpcProtocolError, IpcTimeoutError } from "./errors";
import { LineDecoder, encode } from "./framing";

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

type MethodName = keyof typeof Ipc.Methods;

function isMethodName(method: string): method is MethodName {
  return Object.getOwnPropertyDescriptor(Ipc.Methods, method) !== undefined;
}

function protocolError(message: string, cause?: unknown): IpcProtocolError {
  return Object.freeze(new IpcProtocolError(message, cause));
}

const INVALID_METHOD_WIRE_MESSAGE = "Unknown IPC method";
const INVALID_PARAMS_WIRE_MESSAGE = "Invalid IPC params";
const INVALID_RESULT_WIRE_MESSAGE = "Invalid IPC result";
const INVALID_FRAME_WIRE_MESSAGE = "Invalid IPC frame";
const INVALID_MESSAGE_WIRE_MESSAGE = "Invalid IPC message";
const HANDLER_FAILURE_WIRE_MESSAGE = "IPC handler failed";

function invalidMethodMessage(method: string): string {
  return `Unknown IPC method: ${method}`;
}

function invalidParamsMessage(method: MethodName, details: string): string {
  return `Invalid params for IPC method ${method}: ${details}`;
}

function invalidResultMessage(method: MethodName, details: string): string {
  return `Invalid result for IPC method ${method}: ${details}`;
}

function parseMethodParams(method: MethodName, params: unknown): Record<string, unknown> {
  const parsed = Ipc.Methods[method].params.safeParse(params);
  if (!parsed.success) {
    throw protocolError(invalidParamsMessage(method, parsed.error.message), parsed.error);
  }
  return parsed.data;
}

function parseMethodResult(method: MethodName, result: unknown): unknown {
  const parsed = Ipc.Methods[method].result.safeParse(result);
  if (!parsed.success) {
    throw protocolError(invalidResultMessage(method, parsed.error.message), parsed.error);
  }
  return parsed.data;
}

function writeProtocolError(
  socket: { write(data: Buffer | Uint8Array | string): unknown },
  id: string,
  code: number,
  message:
    | typeof INVALID_METHOD_WIRE_MESSAGE
    | typeof INVALID_PARAMS_WIRE_MESSAGE
    | typeof INVALID_RESULT_WIRE_MESSAGE
    | typeof INVALID_FRAME_WIRE_MESSAGE
    | typeof INVALID_MESSAGE_WIRE_MESSAGE
    | typeof HANDLER_FAILURE_WIRE_MESSAGE,
): void {
  const response = Ipc.Response.parse(Ipc.createErrorResponse(id, code, message));
  socket.write(encode(response));
}

function writeMethodResponse(
  socket: { write(data: Buffer | Uint8Array | string): unknown },
  id: string,
  method: MethodName,
  result: unknown,
): void {
  const response = Ipc.Response.parse(Ipc.createResponse(id, parseMethodResult(method, result)));
  socket.write(encode(response));
}

function validatedMethod(method: string): MethodName {
  if (!isMethodName(method)) throw protocolError(invalidMethodMessage(method));
  return method;
}

type RequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
  respond: (result: unknown) => void,
  notify: (method: string, params?: Record<string, unknown>) => void,
  connectionId: string,
) => void;

interface IpcServer {
  readonly socketPath: string;
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  useConnection(id: string): void;
  closeConnection(id: string): void;
  close(): void;
}

type PendingRequest = {
  method: MethodName;
  connectionId: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
    end(): void;
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
    if (!activeConnectionId) return undefined;
    return connections.get(activeConnectionId)?.socket;
  }

  function removeConnection(id: string, reason: string): void {
    connections.delete(id);
    failPendingForConnection(id, new IpcConnectionError(reason));
    if (id === activeConnectionId) activeConnectionId = undefined;
  }

  function failPendingForConnection(connectionId: string, err: Error): void {
    for (const [requestId, handler] of pending) {
      if (handler.connectionId !== connectionId) continue;
      clearTimeout(handler.timer);
      handler.reject(err);
      pending.delete(requestId);
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
        try {
          messages = state.decoder.push(raw);
        } catch {
          writeProtocolError(socket, "unknown", 4001, INVALID_FRAME_WIRE_MESSAGE);
          return;
        }

        for (const msg of messages) {
          let parsed: Ipc.Request | Ipc.Response | Ipc.Notification;
          try {
            parsed = decodeMessage(msg);
          } catch {
            writeProtocolError(socket, "unknown", 4000, INVALID_MESSAGE_WIRE_MESSAGE);
            continue;
          }

          if (parsed.type === "response") {
            const responseConnectionId = connectionId(socket);
            const pendingRequest = pending.get(parsed.id);
            if (!pendingRequest || pendingRequest.connectionId !== responseConnectionId) {
              failPendingForConnection(
                responseConnectionId,
                protocolError("IPC response mismatch"),
              );
              continue;
            }
            clearTimeout(pendingRequest.timer);
            pending.delete(parsed.id);
            if (parsed.error) {
              pendingRequest.reject(
                protocolError(`IPC error ${parsed.error.code}: ${parsed.error.message}`),
              );
              continue;
            }
            try {
              pendingRequest.resolve(parseMethodResult(pendingRequest.method, parsed.result));
            } catch (error) {
              pendingRequest.reject(
                error instanceof IpcProtocolError
                  ? error
                  : protocolError("Invalid IPC response", error),
              );
            }
          } else if (parsed.type === "request") {
            if (!isMethodName(parsed.method)) {
              writeProtocolError(socket, parsed.id, 2000, INVALID_METHOD_WIRE_MESSAGE);
              continue;
            }
            const method = parsed.method;
            let params: Record<string, unknown>;
            try {
              params = parseMethodParams(method, parsed.params);
            } catch {
              writeProtocolError(socket, parsed.id, 3000, INVALID_PARAMS_WIRE_MESSAGE);
              continue;
            }
            const respond = (result: unknown) => {
              try {
                writeMethodResponse(socket, parsed.id, method, result);
              } catch {
                writeProtocolError(socket, parsed.id, 3000, INVALID_RESULT_WIRE_MESSAGE);
              }
            };
            const notify = (method: string, notificationParams?: Record<string, unknown>) => {
              const knownMethod = validatedMethod(method);
              socket.write(
                encode(
                  Ipc.createNotification(
                    knownMethod,
                    parseMethodParams(knownMethod, notificationParams),
                  ),
                ),
              );
            };
            try {
              handler(method, params, respond, notify, connectionId(socket));
            } catch {
              writeProtocolError(socket, parsed.id, 1000, HANDLER_FAILURE_WIRE_MESSAGE);
            }
          } else if (parsed.type === "notification") {
            if (!isMethodName(parsed.method)) continue;
            let params: Record<string, unknown>;
            try {
              params = parseMethodParams(parsed.method, parsed.params);
            } catch {
              continue;
            }
            try {
              handler(
                parsed.method,
                params,
                () => undefined,
                () => undefined,
                connectionId(socket),
              );
            } catch (error) {
              console.warn(
                "coordinator IPC notification handler failed:",
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }
      },
      close(socket: BunSocket) {
        const id = connectionId(socket);
        removeConnection(id, "socket closed");
      },
      error(socket: BunSocket, _err: Error) {
        const id = connectionId(socket);
        void socket;
        removeConnection(id, "socket error");
      },
    },
  });

  return {
    socketPath,
    call(method, params, timeoutMs = 30_000) {
      let knownMethod: MethodName;
      let parsedParams: Record<string, unknown>;
      try {
        knownMethod = validatedMethod(method);
        parsedParams = parseMethodParams(knownMethod, params);
      } catch (error) {
        return Promise.reject(
          error instanceof IpcProtocolError ? error : protocolError("Invalid IPC request", error),
        );
      }
      const sock = getActiveSocket();
      if (!sock) {
        return Promise.reject(new IpcConnectionError("no connected client"));
      }
      return new Promise((res, rej) => {
        const req = Ipc.createRequest(knownMethod, parsedParams);
        const timer = setTimeout(() => {
          pending.delete(req.id);
          rej(new IpcTimeoutError(`request timeout: ${knownMethod}`));
        }, timeoutMs);
        pending.set(req.id, {
          connectionId: connectionId(sock),
          method: knownMethod,
          resolve: res,
          reject: rej,
          timer,
        });
        sock.write(encode(req));
      });
    },
    notify(method, params) {
      const knownMethod = validatedMethod(method);
      const parsedParams = parseMethodParams(knownMethod, params);
      const sock = getActiveSocket();
      if (sock) {
        sock.write(encode(Ipc.createNotification(knownMethod, parsedParams)));
      }
    },
    useConnection(id) {
      if (connections.has(id)) activeConnectionId = id;
    },
    closeConnection(id) {
      const connection = connections.get(id);
      if (!connection) return;
      connection.socket.end();
      removeConnection(id, "connection rejected");
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

export type IpcMessage = Ipc.Request | Ipc.Response | Ipc.Notification;

export function decodeMessage(raw: unknown): IpcMessage {
  const req = Ipc.Request.safeParse(raw);
  if (req.success) return req.data;

  const res = Ipc.Response.safeParse(raw);
  if (res.success) return res.data;

  const notif = Ipc.Notification.safeParse(raw);
  if (notif.success) return notif.data;

  throw protocolError(`Unknown message type: ${JSON.stringify(raw)}`);
}
