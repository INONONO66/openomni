import { Effect } from "effect";
import type { IdSource, Ipc } from "@openomni/protocol";
import { connectIpcClient as connect, createIpcServer as listen, typedCall as nativeCall } from "../../../src";
import { PeerRequestTable as NativeTable } from "../../../src/ipc/peer-request-table";
import { decodeIpcFailure } from "../../../src/failure";
import { acquire, run, sync } from "./effects";
export * from "../../../src/ipc/errors";
export { classifyIpcMessage } from "../../../src/ipc/peer-request-table";

export function sequentialIds(prefix: string): IdSource {
  let n = 0;
  return () => { n += 1; return `${prefix}-${n}`; };
}
type Handler = (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void, notify: (method: string, params?: Ipc.Notification["params"]) => void, connectionId: string) => void | Promise<void>;
function handlerEffect(body: () => void | Promise<void>) {
  return Effect.try({ try: body, catch: decodeIpcFailure("test.handler") }).pipe(Effect.flatMap((result) => result instanceof Promise ? Effect.tryPromise({ try: () => result, catch: decodeIpcFailure("test.handler") }) : Effect.void));
}
export async function connectIpcClient(path: string, options: {
  idSource?: IdSource; connectTimeoutMs?: number; onDisconnect?: () => void;
  onRequest?: (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void) => void | Promise<void>;
  onNotification?: (method: string, params: Ipc.Notification["params"]) => void | Promise<void>;
} = {}) {
  const { value: native, close } = await acquire(connect(path, {
    idSource: options.idSource ?? sequentialIds("client-req"),
    connectTimeoutMs: options.connectTimeoutMs,
    onDisconnect: options.onDisconnect ? () => handlerEffect(() => options.onDisconnect?.()) : undefined,
    onRequest: options.onRequest ? (method, params, respond) => handlerEffect(() => options.onRequest?.(method, params, respond)) : undefined,
    onNotification: options.onNotification ? (method, params) => handlerEffect(() => options.onNotification?.(method, params)) : undefined,
  }));
  return { native, get connected() { return native.connected; },
    call: (...args: Parameters<typeof native.call>) => run(native.call(...args)),
    close: async () => { await run(native.close()); await close(); },
  };
}
export type IpcClient = Awaited<ReturnType<typeof connectIpcClient>>;
export async function createIpcServer(path: string, handler: Handler, options: { idSource?: IdSource; onDisconnect?: (id: string) => void } = {}) {
  const { value: native, close } = await acquire(listen(path, (...args) => handlerEffect(() => handler(...args)), {
    idSource: options.idSource ?? sequentialIds("server-req"),
    onDisconnect: options.onDisconnect ? (id) => handlerEffect(() => options.onDisconnect?.(id)) : undefined,
  }));
  return { native, socketPath: native.socketPath,
    call: (...args: Parameters<typeof native.call>) => run(native.call(...args)),
    notify: (...args: Parameters<typeof native.notify>) => sync(native.notify(...args)),
    useConnection: native.useConnection,
    close: async () => { await run(native.close()); await close(); },
  };
}
export type IpcServer = Awaited<ReturnType<typeof createIpcServer>>;
export function typedCall<M extends keyof typeof Ipc.Methods>(caller: Pick<IpcClient, "native"> | Pick<IpcServer, "native">, method: M, params: (typeof Ipc.Methods)[M]["params"]["_input"], timeoutMs?: number) {
  return run(nativeCall(caller.native, method, params, timeoutMs));
}
type TableOptions<P> = {
  readonly send: (
    peer: P,
    frame: Ipc.Request | Ipc.Response | Ipc.Notification,
  ) => void;
  readonly idSource?: IdSource;
  readonly onRequest?: (
    peer: P,
    method: string,
    params: Ipc.Request["params"],
    respond: (result: Ipc.Response["result"]) => void,
    notify: (method: string, params?: Ipc.Notification["params"]) => void,
  ) => void | Promise<void>;
  readonly onNotification?: (
    peer: P,
    method: string,
    params: Ipc.Notification["params"],
  ) => void | Promise<void>;
  readonly missingRequestHandlerMessage?: (method: string) => string;
  readonly samePeer?: (pendingPeer: P, inboundPeer: P) => boolean;
};
export class PeerRequestTable<P = undefined> {
  private readonly native: NativeTable<P>;
  constructor(options: TableOptions<P>) {
    this.native = new NativeTable({ ...options,
      idSource: options.idSource ?? sequentialIds("table-req"),
      onRequest: options.onRequest ? (...args) => handlerEffect(() => options.onRequest?.(...args)) : undefined,
      onNotification: options.onNotification ? (...args) => handlerEffect(() => options.onNotification?.(...args)) : undefined,
    });
  }
  call(...args: Parameters<NativeTable<P>["call"]>) { return run(this.native.call(...args)); }
  dispatch(...args: Parameters<NativeTable<P>["dispatch"]>) { return sync(this.native.dispatch(...args)); }
  dispatchMessage(...args: Parameters<NativeTable<P>["dispatchMessage"]>) { return sync(this.native.dispatchMessage(...args)); }
  disconnect(...args: Parameters<NativeTable<P>["disconnect"]>) { this.native.disconnect(...args); }
  disconnectAll(...args: Parameters<NativeTable<P>["disconnectAll"]>) { this.native.disconnectAll(...args); }
}
