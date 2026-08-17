import net from "node:net";
import { Ipc } from "@openomni/protocol";
import { LineDecoder, encode } from "./framing";
import { IpcConnectionError, IpcProtocolError, IpcRemoteError, IpcTimeoutError } from "./errors";

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
  ) => void | Promise<void>;
  onNotification?: (method: string, params: Record<string, unknown> | undefined) => void;
};

export function connectIpcClient(
  socketPath: string,
  options?: ConnectIpcClientOptions,
): Promise<IpcClient> {
  const opts: ConnectIpcClientOptions = options ?? {};
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
      let malformed: string[];
      try {
        ({ frames: msgs, malformed } = decoder.push(chunk));
      } catch (error) {
        // Oversize line/buffer — the decoder dropped its whole buffer (DoS guard).
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
            handler.reject(new IpcRemoteError(error.code, error.message));
          } else {
            handler.resolve(result);
          }
          continue;
        }

        const request = Ipc.Request.safeParse(raw);
        if (request.success) {
          if (!opts.onRequest) {
            // No handler is a remote failure the caller can classify — a
            // silent drop would surface as a timeout on the server side.
            socket.write(
              encode(
                Ipc.createErrorResponse(
                  request.data.id,
                  1000,
                  `client has no request handler for ${request.data.method}`,
                ),
              ),
            );
            continue;
          }
          const respond = (result: unknown) => {
            socket.write(encode(Ipc.createResponse(request.data.id, result)));
          };
          // A failing handler must never escape the socket 'data' listener —
          // that tears down the connection (and can crash the process). Both
          // sync throws AND async rejections become the typed code-1000 error
          // frame instead, mirroring the server side.
          const failRequest = (err: unknown) => {
            socket.write(
              encode(
                Ipc.createErrorResponse(
                  request.data.id,
                  1000,
                  err instanceof Error ? err.message : String(err),
                ),
              ),
            );
          };
          try {
            const result = opts.onRequest(request.data.method, request.data.params, respond);
            if (result instanceof Promise) result.catch(failRequest);
          } catch (err) {
            failRequest(err);
          }
          continue;
        }

        const notification = Ipc.Notification.safeParse(raw);
        if (notification.success) {
          opts.onNotification?.(notification.data.method, notification.data.params);
          continue;
        }

        // Valid JSON that matches no message schema: surface it instead of a
        // silent drop, so a schema-drifted peer is visible in logs rather
        // than as an unexplained stall.
        console.warn(
          `IPC frame matched no message schema: ${String(JSON.stringify(raw)).slice(0, 200)}`,
        );
      }

      // The client stays conservative about a peer that emits garbage — but
      // only after draining every valid frame in the chunk, so a response
      // sharing a chunk with a bad line still resolves its call.
      if (malformed.length > 0) {
        connected = false;
        failAllPending(new IpcProtocolError(`received invalid IPC frame: ${malformed[0] ?? ""}`));
        socket.destroy();
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

    socket.on("end", () => {
      // The server half-closed (FIN). A write-only half-open socket is
      // useless to a request/response transport — and node would otherwise
      // wait to flush any send backlog before closing, which never completes
      // once the peer stopped reading. Tear down and fail pendings NOW.
      connected = false;
      failAllPending(new IpcConnectionError("socket closed by peer"));
      socket.destroy();
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
  });
}
