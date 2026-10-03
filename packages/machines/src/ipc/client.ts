import net from "node:net";
import tls from "node:tls";
import type { IdSource, Ipc, Machine, PlainValue } from "@openomni/protocol";
import { Effect, type Scope } from "effect";
import { IpcConnectionError, IpcPeerKeyMismatchError, IpcProtocolError, type IpcError } from "./errors";
import { decodeIpcFailure } from "../failure";
import { makeDispatcher } from "./callbacks";
import { LineDecoder, encode } from "./framing";
import { classifyIpcMessage, PeerRequestTable } from "./peer-request-table";
import { certificateKeyFingerprint, type IpcTlsIdentity } from "./tls";

export interface IpcClient {
  call(method: string, params?: Ipc.Request["params"], timeoutMs?: number): Effect.Effect<Ipc.Response["result"], IpcError>;
  close(): Effect.Effect<void, IpcError>;
  readonly connected: boolean;
}
export type ConnectIpcClientOptions = {
  /** Injected request-id entropy (#1245): required, no ambient crypto fallback. */
  readonly idSource: IdSource;
  connectTimeoutMs?: number;
  onDisconnect?: () => Effect.Effect<void, IpcError>;
  onRequest?: (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void) => Effect.Effect<void, IpcError>;
  onNotification?: (method: string, params: Ipc.Notification["params"]) => Effect.Effect<void, IpcError>;
};

/** A started connection attempt: the socket plus its ready-time pin check. */
type StartedSocket = {
  readonly socket: net.Socket;
  /**
   * Runs when `readyEvent` fires, BEFORE the client is marked connected and
   * therefore before any frame can be written. A defined result aborts the
   * connection with that typed failure — there is no fallback transport.
   */
  readonly verifyPeer?: () => IpcError | undefined;
};

/** One connected-byte-stream contract; Unix and TLS-over-TCP differ only here. */
type ClientTransport = {
  /** Names the target in connect-timeout errors. */
  readonly endpoint: string;
  /** The event that marks the stream ready for frames (TLS: after handshake). */
  readonly readyEvent: "connect" | "secureConnect";
  /** Creates the socket and initiates the connection. */
  readonly start: () => StartedSocket;
};

export function connectIpcClient(socketPath: string, opts: ConnectIpcClientOptions): Effect.Effect<IpcClient, IpcError, Scope.Scope> {
  return connectOverTransport({
    endpoint: socketPath,
    readyEvent: "connect",
    start: () => {
      const socket = new net.Socket();
      socket.connect(socketPath);
      return { socket };
    },
  }, opts);
}

/** TLS-over-TCP connection spec (#1270): both directions are pin-trusted. */
export type IpcTcpConnectSpec = {
  readonly tcp: { readonly host: string; readonly port: number };
  /** The client identity presented to the server's mutual-TLS requirement. */
  readonly tls: IpcTlsIdentity;
  /**
   * Pinned host key: the canonical sha256(SPKI DER) fingerprint the presented
   * server certificate must match. TLS completes only on equality — a
   * mismatch fails `IpcPeerKeyMismatchError` before any frame is sent.
   */
  readonly hostPublicKey: Machine.KeyFingerprint;
};

export function connectIpcTcpClient(spec: IpcTcpConnectSpec, opts: ConnectIpcClientOptions): Effect.Effect<IpcClient, IpcError, Scope.Scope> {
  return connectOverTransport({
    endpoint: `${spec.tcp.host}:${spec.tcp.port}`,
    readyEvent: "secureConnect",
    start: () => {
      const socket = tls.connect({
        host: spec.tcp.host,
        port: spec.tcp.port,
        cert: spec.tls.certificate,
        key: spec.tls.privateKey,
        // CodeQL js/disabling-certificate-validation — intentional (#1270):
        // daemon/host certs are self-signed, so OpenSSL chain validation can
        // never succeed; the validation IS the SPKI pin in hostPinMismatch(),
        // enforced on secureConnect with typed IpcPeerKeyMismatchError and no
        // fallback (proof: network-tls.test.ts "a wrong host key fails the
        // client with a typed peer_key_mismatch before any frame reaches the
        // server").
        rejectUnauthorized: false,
      });
      return { socket, verifyPeer: () => hostPinMismatch(socket, spec.hostPublicKey) };
    },
  }, opts);
}

function hostPinMismatch(socket: tls.TLSSocket, expected: string): IpcError | undefined {
  const presented = certificateKeyFingerprint(socket.getPeerCertificate().raw);
  if (presented === expected) return undefined;
  return new IpcPeerKeyMismatchError({
    message: `host key mismatch: expected ${expected}, presented ${presented}`,
    expected,
    presented,
  });
}

type Dispatch = (task: Effect.Effect<void, IpcError>) => void;

type ClientFrameSink = {
  readonly decoder: LineDecoder;
  readonly peer: PeerRequestTable<undefined>;
  readonly dispatch: Dispatch;
  /** Frame-level failure: fail pendings and tear the stream down. */
  readonly fail: (error: IpcError) => void;
};

function dispatchClientFrame(raw: PlainValue, sink: ClientFrameSink): Effect.Effect<void, IpcError> {
  const message = classifyIpcMessage(raw);
  if (message === undefined) {
    return Effect.logWarning(`IPC frame matched no message schema: ${String(JSON.stringify(raw)).slice(0, 200)}`);
  }
  if (message.kind === "response") return sink.peer.dispatchMessage(message, undefined);
  return Effect.sync(() => sink.dispatch(sink.peer.dispatchMessage(message, undefined)));
}

function makeClientDataHandler(sink: ClientFrameSink): (chunk: Buffer) => void {
  return (chunk) => sink.dispatch(Effect.gen(function* () {
    const { frames, malformed } = yield* Effect.try({ try: () => sink.decoder.push(chunk), catch: decodeIpcFailure("frame.decode") });
    for (const raw of frames) yield* dispatchClientFrame(raw, sink);
    if (malformed.length > 0) return yield* new IpcProtocolError({ message: `received invalid IPC frame: ${malformed[0]}` });
  }).pipe(Effect.catch((error) => Effect.sync(() => sink.fail(error)))));
}

function connectOverTransport(transport: ClientTransport, opts: ConnectIpcClientOptions): Effect.Effect<IpcClient, IpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const dispatch = yield* makeDispatcher;
    const decoder = new LineDecoder();
    let socket: net.Socket | undefined;
    let connected = false;
    let closed = false;
    const peer = new PeerRequestTable({
      idSource: opts.idSource,
      send: (_peer, frame) => { if (connected && !closed) socket?.write(encode(frame)); },
      onRequest: opts.onRequest ? (_peer, method, params, respond) => opts.onRequest?.(method, params, respond) ?? Effect.void : undefined,
      onNotification: (_peer, method, params) => opts.onNotification?.(method, params) ?? Effect.void,
      missingRequestHandlerMessage: (method) => `client has no request handler for ${method}`,
    });
    const close = Effect.sync(() => {
      if (closed) return;
      closed = true;
      connected = false;
      peer.disconnectAll(new IpcConnectionError({ message: "client closed" }));
      socket?.destroy();
    });
    yield* Effect.addFinalizer(() => close);
    const client: IpcClient = {
      get connected() { return connected; },
      call(method, params, timeoutMs = 30_000) {
        return Effect.suspend(() => connected ? peer.call(undefined, method, params, timeoutMs) : new IpcConnectionError({ message: "not connected" }));
      },
      close: () => close,
    };
    const onData = makeClientDataHandler({
      decoder,
      peer,
      dispatch,
      fail: (error) => {
        connected = false;
        peer.disconnectAll(error);
        socket?.destroy();
      },
    });
    yield* Effect.callback<void, IpcError>((resume) => {
      // Create + wire in one synchronous block: no event can slip between the
      // connection attempt and its handlers.
      const started = transport.start();
      const stream = started.socket;
      socket = stream;
      stream.on("data", onData);
      stream.on("close", () => {
        connected = false;
        peer.disconnectAll(new IpcConnectionError({ message: "socket closed" }));
        if (opts.onDisconnect) dispatch(opts.onDisconnect());
      });
      stream.on("end", () => {
        connected = false;
        peer.disconnectAll(new IpcConnectionError({ message: "socket closed by peer" }));
        stream.destroy();
      });
      stream.on("error", (error) => {
        const failure = new IpcConnectionError({ message: `socket error: ${error.message}`, cause: String(error) });
        connected = false;
        peer.disconnectAll(failure);
        resume(Effect.fail(failure));
      });
      stream.once(transport.readyEvent, () => {
        const failure = started.verifyPeer?.();
        if (failure !== undefined) {
          // Pin mismatch: the stream dies BEFORE `connected` ever turns true,
          // so no frame was or can be sent. No fallback transport exists.
          peer.disconnectAll(failure);
          stream.destroy();
          resume(Effect.fail(failure));
          return;
        }
        connected = true;
        resume(Effect.void);
      });
    }).pipe(
      Effect.timeoutOrElse({ duration: opts.connectTimeoutMs ?? 5000, orElse: () => Effect.fail(new IpcConnectionError({ message: `connect timeout: ${transport.endpoint}` }))}),
      Effect.onError(() => close),
    );
    return client;
  });
}
