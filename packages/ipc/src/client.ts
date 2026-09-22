import net from "node:net";
import type { Ipc } from "@openomni/protocol";
import { Effect, type Scope } from "effect";
import { IpcConnectionError, IpcProtocolError, type IpcError } from "./errors";
import { decodeIpcFailure } from "./failure";
import { makeDispatcher } from "./callbacks";
import { LineDecoder, encode } from "./framing";
import { classifyIpcMessage, PeerRequestTable } from "./peer-request-table";

export interface IpcClient {
  call(method: string, params?: Ipc.Request["params"], timeoutMs?: number): Effect.Effect<Ipc.Response["result"], IpcError>;
  close(): Effect.Effect<void, IpcError>;
  readonly connected: boolean;
}
export type ConnectIpcClientOptions = {
  connectTimeoutMs?: number;
  onDisconnect?: () => Effect.Effect<void, IpcError>;
  onRequest?: (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void) => Effect.Effect<void, IpcError>;
  onNotification?: (method: string, params: Ipc.Notification["params"]) => Effect.Effect<void, IpcError>;
};
export function connectIpcClient(socketPath: string, opts: ConnectIpcClientOptions = {}): Effect.Effect<IpcClient, IpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const dispatch = yield* makeDispatcher;
    const socket = new net.Socket();
    const decoder = new LineDecoder();
    let connected = false;
    let closed = false;
    const peer = new PeerRequestTable({
      send: (_peer, frame) => socket.write(encode(frame)),
      onRequest: opts.onRequest ? (_peer, method, params, respond) => opts.onRequest?.(method, params, respond) ?? Effect.void : undefined,
      onNotification: (_peer, method, params) => opts.onNotification?.(method, params) ?? Effect.void,
      missingRequestHandlerMessage: (method) => `client has no request handler for ${method}`,
    });
    const close = Effect.sync(() => {
      if (closed) return;
      closed = true;
      connected = false;
      peer.disconnectAll(new IpcConnectionError({ message: "client closed" }));
      socket.destroy();
    });
    yield* Effect.addFinalizer(() => close);
    const client: IpcClient = {
      get connected() { return connected; },
      call(method, params, timeoutMs = 30_000) {
        return Effect.suspend(() => connected ? peer.call(undefined, method, params, timeoutMs) : new IpcConnectionError({ message: "not connected" }));
      },
      close: () => close,
    };
    socket.on("data", (chunk) => dispatch(Effect.gen(function* () {
      const { frames, malformed } = yield* Effect.try({ try: () => decoder.push(chunk), catch: decodeIpcFailure("frame.decode") });
      for (const raw of frames) {
        const message = classifyIpcMessage(raw);
        if (message === undefined) {
          console.warn(`IPC frame matched no message schema: ${String(JSON.stringify(raw)).slice(0, 200)}`);
        } else if (message.kind === "response") {
          yield* peer.dispatchMessage(message, undefined);
        } else {
          dispatch(peer.dispatchMessage(message, undefined));
        }
      }
      if (malformed.length > 0) return yield* new IpcProtocolError({ message: `received invalid IPC frame: ${malformed[0]}` });
    }).pipe(Effect.catchAll((error) => Effect.sync(() => {
      connected = false;
      peer.disconnectAll(error);
      socket.destroy();
    })))));
    socket.on("close", () => {
      connected = false;
      peer.disconnectAll(new IpcConnectionError({ message: "socket closed" }));
      if (opts.onDisconnect) dispatch(opts.onDisconnect());
    });
    socket.on("end", () => {
      connected = false;
      peer.disconnectAll(new IpcConnectionError({ message: "socket closed by peer" }));
      socket.destroy();
    });
    yield* Effect.async<void, IpcError>((resume) => {
      socket.on("error", (error) => {
        const failure = new IpcConnectionError({ message: `socket error: ${error.message}`, cause: String(error) });
        connected = false;
        peer.disconnectAll(failure);
        resume(Effect.fail(failure));
      });
      socket.once("connect", () => { connected = true; resume(Effect.void); });
      socket.connect(socketPath);
    }).pipe(
      Effect.timeoutFail({ duration: opts.connectTimeoutMs ?? 5000, onTimeout: () => new IpcConnectionError({ message: `connect timeout: ${socketPath}` }) }),
      Effect.onError(() => close),
    );
    return client;
  });
}
