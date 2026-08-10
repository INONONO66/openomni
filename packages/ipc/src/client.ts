import net from "node:net";
import { Ipc } from "@openomni/protocol";
import { LineDecoder, encode } from "./framing";
import { IpcConnectionError, IpcProtocolError, IpcTimeoutError } from "./errors";

export interface IpcClient {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
  readonly connected: boolean;
}

type PendingRequest = {
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
      reject(new IpcConnectionError(`connect timeout: ${socketPath}`));
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
        failAllPending(new IpcProtocolError("received invalid IPC frame", error));
        socket.destroy();
        return;
      }
      for (const raw of msgs) {
        const response = Ipc.Response.safeParse(raw);
        if (response.success) {
          const { id, result, error } = response.data;
          const handler = pending.get(id);
          if (!handler) continue;
          clearTimeout(handler.timer);
          pending.delete(id);
          if (error) {
            handler.reject(new IpcConnectionError(`IPC error ${error.code}: ${error.message}`));
          } else {
            handler.resolve(result);
          }
          continue;
        }

        const request = Ipc.Request.safeParse(raw);
        if (request.success) {
          if (opts.onRequest) {
            const respond = (result: unknown) => {
              socket.write(encode(Ipc.createResponse(request.data.id, result)));
            };
            // A throwing handler must never escape the socket 'data' listener —
            // that tears down the connection (and can crash the process). Turn
            // it into a typed error response instead, mirroring the server side.
            try {
              opts.onRequest(request.data.method, request.data.params, respond);
            } catch (err) {
              socket.write(
                encode(
                  Ipc.createErrorResponse(
                    request.data.id,
                    1000,
                    err instanceof Error ? err.message : String(err),
                  ),
                ),
              );
            }
          }
          continue;
        }

        const notification = Ipc.Notification.safeParse(raw);
        if (notification.success && opts.onNotification) {
          opts.onNotification(notification.data.method, notification.data.params);
        }
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
        if (!connected) {
          return Promise.reject(new IpcConnectionError("not connected"));
        }
        return new Promise((res, rej) => {
          const req = Ipc.createRequest(method, params);
          const timer = setTimeout(() => {
            pending.delete(req.id);
            rej(new IpcTimeoutError(`request timeout: ${method}`));
          }, timeoutMs);
          pending.set(req.id, { resolve: res, reject: rej, timer });
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
