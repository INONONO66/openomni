import net from "node:net";
import { Ipc } from "@openomni/protocol";
import { LineDecoder, encode } from "./framing";
import { IpcConnectionError, IpcProtocolError, IpcTimeoutError } from "./errors";

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

function writeProtocolError(
  socket: { write(data: Buffer | Uint8Array | string): unknown },
  id: string,
  code: number,
  message:
    | typeof INVALID_METHOD_WIRE_MESSAGE
    | typeof INVALID_PARAMS_WIRE_MESSAGE
    | typeof INVALID_RESULT_WIRE_MESSAGE,
): void {
  const response = Ipc.Response.parse(Ipc.createErrorResponse(id, code, message));
  socket.write(encode(response));
}

function invalidMethodMessage(method: string): string {
  return `Unknown IPC method: ${method}`;
}

function parseMethodParams(method: MethodName, params: unknown): Record<string, unknown> {
  const parsed = Ipc.Methods[method].params.safeParse(params);
  if (!parsed.success) {
    throw protocolError(
      `Invalid params for IPC method ${method}: ${parsed.error.message}`,
      parsed.error,
    );
  }
  return parsed.data;
}

function parseMethodResult(method: MethodName, result: unknown): unknown {
  const parsed = Ipc.Methods[method].result.safeParse(result);
  if (!parsed.success) {
    throw protocolError(
      `Invalid result for IPC method ${method}: ${parsed.error.message}`,
      parsed.error,
    );
  }
  return parsed.data;
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

export interface IpcClient {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
  readonly connected: boolean;
}

type PendingRequest = {
  method: MethodName;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ConnectIpcClientOptions = {
  connectTimeoutMs?: number;
  onRequest?: (
    method: string,
    params: Record<string, unknown> | undefined,
    respond: (result: unknown) => void,
  ) => void;
  onNotification?: (method: string, params: Record<string, unknown> | undefined) => void;
};

export function connectIpcClient(socketPath: string, connectTimeoutMs?: number): Promise<IpcClient>;
export function connectIpcClient(
  socketPath: string,
  options?: ConnectIpcClientOptions,
): Promise<IpcClient>;
export function connectIpcClient(
  socketPath: string,
  optionsOrTimeout?: ConnectIpcClientOptions | number,
): Promise<IpcClient> {
  const opts: ConnectIpcClientOptions =
    typeof optionsOrTimeout === "number"
      ? { connectTimeoutMs: optionsOrTimeout }
      : (optionsOrTimeout ?? {});
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5000;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const decoder = new LineDecoder();
    const pending = new Map<string, PendingRequest>();
    let connected = false;

    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new IpcConnectionError("IPC connection timed out"));
    }, connectTimeoutMs);

    function failAllPending(err: Error): void {
      for (const [, handler] of pending) {
        clearTimeout(handler.timer);
        handler.reject(err);
      }
      pending.clear();
    }

    socket.on("connect", () => {
      clearTimeout(connectTimer);
      connected = true;
      resolve(client);
    });

    socket.on("data", (chunk) => {
      let msgs: unknown[];
      try {
        msgs = decoder.push(chunk);
      } catch (error) {
        connected = false;
        failAllPending(protocolError("received invalid IPC frame", error));
        socket.destroy();
        return;
      }
      for (const raw of msgs) {
        const response = Ipc.Response.safeParse(raw);
        if (response.success) {
          const { id, result, error } = response.data;
          const pendingRequest = pending.get(id);
          if (!pendingRequest) {
            failAllPending(protocolError(`IPC response mismatch: unexpected id ${id}`));
            continue;
          }
          clearTimeout(pendingRequest.timer);
          pending.delete(id);
          if (error) {
            pendingRequest.reject(protocolError(`IPC error ${error.code}: ${error.message}`));
          } else {
            try {
              pendingRequest.resolve(parseMethodResult(pendingRequest.method, result));
            } catch (parseError) {
              pendingRequest.reject(
                parseError instanceof IpcProtocolError
                  ? parseError
                  : protocolError("Invalid IPC response", parseError),
              );
            }
          }
          continue;
        }

        const request = Ipc.Request.safeParse(raw);
        if (request.success) {
          const { id, method } = request.data;
          if (!isMethodName(method)) {
            writeProtocolError(socket, id, 2000, INVALID_METHOD_WIRE_MESSAGE);
            continue;
          }
          let params: Record<string, unknown>;
          try {
            params = parseMethodParams(method, request.data.params);
          } catch {
            writeProtocolError(socket, id, 3000, INVALID_PARAMS_WIRE_MESSAGE);
            continue;
          }
          if (opts.onRequest) {
            const respond = (result: unknown) => {
              try {
                writeMethodResponse(socket, id, method, result);
              } catch {
                writeProtocolError(socket, id, 3000, INVALID_RESULT_WIRE_MESSAGE);
              }
            };
            opts.onRequest(method, params, respond);
          }
          continue;
        }

        const notification = Ipc.Notification.safeParse(raw);
        if (notification.success) {
          if (!isMethodName(notification.data.method)) {
            failAllPending(protocolError(invalidMethodMessage(notification.data.method)));
            continue;
          }
          try {
            const params = parseMethodParams(notification.data.method, notification.data.params);
            opts.onNotification?.(notification.data.method, params);
          } catch (parseError) {
            failAllPending(
              parseError instanceof IpcProtocolError
                ? parseError
                : protocolError("Invalid IPC notification", parseError),
            );
          }
          continue;
        }
        failAllPending(protocolError(`Unknown IPC message type: ${JSON.stringify(raw)}`));
      }
    });

    socket.on("error", (err) => {
      if (!connected) {
        clearTimeout(connectTimer);
        reject(new IpcConnectionError(`socket error: ${err.message}`, err));
        return;
      }
      connected = false;
      failAllPending(new IpcConnectionError(`socket error: ${err.message}`, err));
    });

    socket.on("close", () => {
      connected = false;
      failAllPending(new IpcConnectionError("socket closed"));
    });

    const client: IpcClient = {
      get connected() {
        return connected;
      },
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
        if (!connected) {
          return Promise.reject(new IpcConnectionError("not connected"));
        }
        return new Promise((res, rej) => {
          const req = Ipc.createRequest(knownMethod, parsedParams);
          const timer = setTimeout(() => {
            pending.delete(req.id);
            rej(new IpcTimeoutError(`request timeout: ${knownMethod}`));
          }, timeoutMs);
          pending.set(req.id, { method: knownMethod, resolve: res, reject: rej, timer });
          socket.write(encode(req));
        });
      },
      close() {
        connected = false;
        failAllPending(new IpcConnectionError("client closed"));
        socket.destroy();
      },
    };

    return client;
  });
}
