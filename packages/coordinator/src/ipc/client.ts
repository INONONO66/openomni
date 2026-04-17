import net from "node:net";
import { Ipc } from "@openomni/protocol";
import { LineDecoder, encode } from "./framing.js";
import { IpcConnectionError, IpcTimeoutError } from "./errors.js";

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

export function connectIpcClient(socketPath: string, connectTimeoutMs = 5000): Promise<IpcClient> {
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
      } catch {
        return;
      }
      for (const raw of msgs) {
        const parsed = Ipc.Response.safeParse(raw);
        if (!parsed.success) continue;
        const { id, result, error } = parsed.data;
        const handler = pending.get(id);
        if (!handler) continue;
        clearTimeout(handler.timer);
        pending.delete(id);
        if (error) {
          handler.reject(new IpcConnectionError(`IPC error ${error.code}: ${error.message}`));
        } else {
          handler.resolve(result);
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
  });
}
