import net from "node:net";
import { IpcConnectionError, IpcProtocolError } from "./errors";
import { LineDecoder, encode } from "./framing";
import { PeerRequestTable } from "./peer-request-table";

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
    // Register listeners before initiating the connection; Bun 1.3.6 may
    // emit a refused-connect error during the initial connection turn.
    const socket = new net.Socket();
    const decoder = new LineDecoder();
    let connected = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let peer!: PeerRequestTable;

    const failAllPending = (err: Error): void => {
      peer.disconnectAll(err);
    };

    socket.on("error", (err) => {
      if (!connected) {
        if (connectTimer) clearTimeout(connectTimer);
        reject(new IpcConnectionError(`socket error: ${err.message}`, err));
        return;
      }
      connected = false;
      failAllPending(new IpcConnectionError(`socket error: ${err.message}`, err));
    });

    peer = new PeerRequestTable({
      send: (_peer, frame) => socket.write(encode(frame)),
      onRequest: opts.onRequest
        ? (_peer, method, params, respond) => opts.onRequest?.(method, params, respond)
        : undefined,
      onNotification: (_peer, method, params) => opts.onNotification?.(method, params),
      missingRequestHandlerMessage: (method) => `client has no request handler for ${method}`,
    });

    connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new IpcConnectionError(`connect timeout: ${socketPath}`));
    }, connectTimeoutMs);

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
        if (peer.dispatch(raw, undefined)) continue;

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
        return peer.call(undefined, method, params, timeoutMs);
      },
      close() {
        connected = false;
        failAllPending(new IpcConnectionError("client closed"));
        socket.destroy();
      },
    };
    socket.connect(socketPath);
  });
}
