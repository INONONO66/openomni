import net from "node:net";
import { Ipc } from "@openomni/protocol";
import { IpcConnectionError, IpcProtocolError, IpcRemoteError, IpcTimeoutError } from "./errors";
import { LineDecoder, encode } from "./framing";
import { PendingCalls } from "./pending-calls";

export interface IpcClient {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
  readonly connected: boolean;
}

export type ConnectIpcClientOptions = {
  connectTimeoutMs?: number;
  onRequest?: (
    method: string,
    params: Record<string, unknown> | undefined,
    respond: (result: unknown) => void,
  ) => void | Promise<void>;
  onNotification?: (
    method: string,
    params: Record<string, unknown> | undefined,
  ) => void | Promise<void>;
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
    const pending = new PendingCalls();
    let connected = false;

    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new IpcConnectionError(`connect timeout: ${socketPath}`));
    }, connectTimeoutMs);

    function failAllPending(err: Error): void {
      pending.failAll(err);
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
          pending.settle(
            id,
            error
              ? { ok: false, error: new IpcRemoteError(error.code, error.message) }
              : { ok: true, value: result },
          );
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
          // Notifications get no error frame per the protocol spec, but a
          // throwing handler must not escape the 'data' listener either —
          // that is an uncaughtException in whatever process hosts this
          // client (e.g. the coordinator supervisor). Mirror the server:
          // log and keep draining, for sync throws AND async rejections.
          const warnFailure = (error: unknown) => {
            console.warn(
              "IPC notification handler failed:",
              error instanceof Error ? error.message : String(error),
            );
          };
          try {
            const result = opts.onNotification?.(
              notification.data.method,
              notification.data.params,
            );
            if (result instanceof Promise) result.catch(warnFailure);
          } catch (error) {
            warnFailure(error);
          }
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
        failAllPending(new IpcProtocolError(`received invalid IPC frame: ${malformed[0]}`));
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
        const req = Ipc.createRequest(method, params);
        return pending.register(
          req.id,
          timeoutMs,
          () => new IpcTimeoutError(`request timeout: ${method}`),
          { send: () => socket.write(encode(req)) },
        );
      },
      close() {
        connected = false;
        failAllPending(new IpcConnectionError("client closed"));
        socket.destroy();
      },
    };
  });
}
