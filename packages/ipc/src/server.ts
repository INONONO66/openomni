import fs from "node:fs";
import net from "node:net";
import { Ipc, type PlainValue } from "@openomni/protocol";

import { Effect, type Scope } from "effect";
import { IpcConnectionError, type IpcError } from "./errors";
import { decodeIpcFailure } from "./failure";
import { makeDispatcher } from "./callbacks";
import { LineDecoder, encode } from "./framing";
import { classifyIpcMessage, PeerRequestTable } from "./peer-request-table";

/** Remove the socket file, tolerating a concurrent removal (ENOENT). */
function unlinkIfExists(socketPath: string): void {
  fs.rmSync(socketPath, { force: true });
}

interface IpcServerOptions {
  /**
   * Fires once per connection after it is torn down (close or error). The
   * connection's in-flight requests have already been failed when this runs.
   */
  readonly onDisconnect?: (connectionId: string) => Effect.Effect<void, IpcError>;
}

type RequestHandler = (
  method: string,
  params: Ipc.Request["params"],
  respond: (result: Ipc.Response["result"]) => void,
  notify: (method: string, params?: Ipc.Notification["params"]) => void,
  connectionId: string,
) => Effect.Effect<void, IpcError>;

export interface IpcServer {
  readonly socketPath: string;
  call(
    method: string,
    params?: Ipc.Request["params"],
    timeoutMs?: number,
  ): Effect.Effect<Ipc.Response["result"], IpcError>;
  /** Returns false when the notification was dropped because no client is connected. */
  notify(method: string, params?: Ipc.Notification["params"]): Effect.Effect<boolean, IpcError>;
  useConnection(id: string): void;
  close(): Effect.Effect<void, IpcError>;
}

// How long the pre-listen probe waits for the existing socket to answer
// before concluding it is dead. No answer means "assume live": stealing a
// live server's socket wedges BOTH servers, so ambiguity resolves to refusal.
const SOCKET_PROBE_TIMEOUT_MS = 500;

/**
 * True when something accepts connections on `socketPath`. Connection refused
 * (or any other connect error) means the socket file is a stale leftover.
 */
function probeSocketLive(socketPath: string): Effect.Effect<boolean> {
  return Effect.async<boolean>((resume) => {
    const probe = new net.Socket();
    probe.once("error", () => { probe.destroy(); resume(Effect.succeed(false)); });
    probe.once("connect", () => { probe.destroy(); resume(Effect.succeed(true)); });
    probe.connect(socketPath);
    return Effect.sync(() => probe.destroy());
  }).pipe(Effect.timeoutOption(SOCKET_PROBE_TIMEOUT_MS), Effect.map((value) => value._tag === "None" || value.value));
}

export function createIpcServer(
  socketPath: string,
  handler: RequestHandler,
  options: IpcServerOptions = {},
): Effect.Effect<IpcServer, IpcError, Scope.Scope> {
  return Effect.gen(function* () {
  const dispatch = yield* makeDispatcher;
  // A leftover socket file blocks Bun.listen with EADDRINUSE — but blindly
  // unlinking would steal a LIVE server's socket (new connections silently
  // divert to the newcomer while the old server keeps running blind). Probe
  // first; only a provably dead socket file is removed.
  if (fs.existsSync(socketPath)) {
    if (yield* probeSocketLive(socketPath)) {
      return yield* new IpcConnectionError({ message: `socket ${socketPath} is in use by a live server` });
    }
    yield* Effect.try({ try: () => unlinkIfExists(socketPath), catch: decodeIpcFailure("socket.unlink") });
  }

  interface SocketData {
    id: string;
  }

  interface BunSocket {
    data: SocketData | undefined;
    write(data: Buffer | Uint8Array | string): number;
    end(): void;
  }

  function connectionIdOf(socket: BunSocket): string | undefined {
    return socket.data?.id;
  }

  type ConnectionState = {
    id: string;
    socket: BunSocket;
    decoder: LineDecoder;
    /**
     * Bytes the kernel did not accept yet. Bun sockets do NOT buffer partial
     * writes (unlike node:net) — whatever `socket.write` returns short must
     * be kept here and flushed on `drain`, or the frame is silently
     * truncated and the NDJSON stream desyncs.
     */
    writeQueue: Uint8Array[];
    /** Close the socket once every queued byte flushed (protocol desync). */
    endAfterFlush: boolean;
    /** The socket is gone; drop writes instead of queueing them forever. */
    closed: boolean;
  };

  const connections = new Map<string, ConnectionState>();
  let connCounter = 0;
  let activeConnectionId: string | undefined;

  function send(state: ConnectionState, bytes: Uint8Array): void {
    if (state.closed) return;
    if (state.writeQueue.length > 0) {
      // Earlier bytes are still waiting for drain — writing now would
      // interleave into the middle of a queued frame.
      state.writeQueue.push(bytes);
      return;
    }
    const written = state.socket.write(bytes);
    if (written < bytes.length) {
      state.writeQueue.push(written > 0 ? bytes.subarray(written) : bytes);
    }
  }

  function sendFrame(state: ConnectionState, msg: Ipc.Request | Ipc.Response | Ipc.Notification): void {
    send(state, encode(msg));
  }

  const peer = new PeerRequestTable<ConnectionState>({
    send: sendFrame,
    samePeer: (pendingPeer, inboundPeer) => pendingPeer.id === inboundPeer.id,
    onRequest: (state, method, params, respond, notify) =>
      handler(method, params, respond, notify, state.id),
    onNotification: (state, method, params) =>
      handler(
        method,
        params,
        () => undefined,
        () => undefined,
        state.id,
      ),
  });

  function flushQueued(state: ConnectionState): void {
    if (state.closed) return;
    while (state.writeQueue.length > 0) {
      const chunk = state.writeQueue[0] as Uint8Array;
      const written = state.socket.write(chunk);
      if (written < chunk.length) {
        if (written > 0) state.writeQueue[0] = chunk.subarray(written);
        return; // kernel buffer full again — wait for the next drain
      }
      state.writeQueue.shift();
    }
    if (state.endAfterFlush) state.socket.end();
  }

  /**
   * Close once every queued byte flushed. end() half-closes: the already
   * flushed error frame reaches the peer with the FIN behind it, and Bun
   * fires this side's close handler (which releases the connection state and
   * fails its pendings). The IpcClient tears down on that FIN; a foreign
   * peer stuck mid-flood only strands its own socket, not the server's.
   */
  function closeAfterFlush(state: ConnectionState): void {
    state.endAfterFlush = true;
    if (state.writeQueue.length === 0 && !state.closed) state.socket.end();
  }

  function getActiveConnection(): ConnectionState | undefined {
    if (activeConnectionId) {
      return connections.get(activeConnectionId);
    }
    const first = connections.values().next();
    return first.done ? undefined : first.value;
  }

  function removeConnection(id: string, reason: string): void {
    const state = connections.get(id);
    if (state) state.closed = true;
    connections.delete(id);
    if (id === activeConnectionId) {
      // Clear the pin: leaving it set to a now-dead connection wedges
      // getActiveConnection() (it resolves the stale id, finds nothing, and
      // never falls through to a surviving connection), so no next
      // connection binds.
      activeConnectionId = undefined;
    }
    // A dead connection fails ITS in-flight requests as a connection loss —
    // leaving them to age out would misreport the failure as a timeout. This
    // includes requests whose bytes were still sitting in the write queue.
    if (state) peer.disconnect(state, new IpcConnectionError({ message: reason }));
    // `state` guards double delivery: close always follows error, and the
    // second call finds the connection already deleted.
    if (state && options.onDisconnect) dispatch(options.onDisconnect(id));
  }

  function dispatchFrame(msg: PlainValue, state: ConnectionState): Effect.Effect<void, IpcError> {
    const message = classifyIpcMessage(msg);
    if (message === undefined) return Effect.sync(() => sendFrame(state, Ipc.createErrorResponse(extractFrameId(msg), 4000, unknownMessageError(msg))));
    if (message.kind === "response") return peer.dispatchMessage(message, state);
    return Effect.sync(() => dispatch(peer.dispatchMessage(message, state).pipe(Effect.catchAllCause((cause) => Effect.sync(() => {
      console.warn("IPC request handler defect:", cause);
      removeConnection(state.id, "request handler defect");
      state.socket.end();
    })))));
  }

  const server = yield* Effect.try({ try: () => Bun.listen({
    unix: socketPath,
    socket: {
      open(socket: BunSocket) {
        const id = `conn-${++connCounter}`;
        socket.data = { id } satisfies SocketData;
        connections.set(id, {
          id,
          socket,
          decoder: new LineDecoder(),
          writeQueue: [],
          endAfterFlush: false,
          closed: false,
        });
      },
      data(socket: BunSocket, raw: Buffer) {
        const connId = connectionIdOf(socket);
        const state = connId === undefined ? undefined : connections.get(connId);
        if (!state) return;
        // A condemned connection's remaining inbound flood is dropped without
        // decoding: re-buffering megabytes of garbage per chunk pins the event
        // loop (and the reclaim timer with it) for nothing.
        if (state.endAfterFlush) return;

        dispatch(Effect.gen(function* () {
          if (state.endAfterFlush || state.closed) return;
          const { frames: messages, malformed } = yield* Effect.try({ try: () => state.decoder.push(raw), catch: decodeIpcFailure("frame.decode") });
          for (const msg of messages) yield* dispatchFrame(msg, state);
          for (const line of malformed) sendFrame(state, Ipc.createErrorResponse("unknown", 4001, `IPC frame is not valid JSON: ${line}`));
        }).pipe(Effect.catchAll((error) => Effect.sync(() => {
          sendFrame(state, Ipc.createErrorResponse("unknown", 4001, error.message || String(error)));
          closeAfterFlush(state);
        }))));
      },
      drain(socket: BunSocket) {
        const connId = connectionIdOf(socket);
        const state = connId === undefined ? undefined : connections.get(connId);
        if (state) flushQueued(state);
      },
      error(socket: BunSocket, error: Error) {
        const id = connectionIdOf(socket);
        if (id !== undefined) removeConnection(id, `socket error: ${error.message}`);
      },
      close(socket: BunSocket) {
        // The connection may die before `open` assigned socket.data.
        const id = connectionIdOf(socket);
        if (id !== undefined) removeConnection(id, "socket closed");
      },
    },
  }), catch: decodeIpcFailure("server.listen") });

  let closed = false;
  const close = Effect.try({ try: () => {
    if (closed) return;
    closed = true;
    peer.disconnectAll(new IpcConnectionError({ message: "server closed" }));
    server.stop(true);
    unlinkIfExists(socketPath);
  }, catch: decodeIpcFailure("server.close") });
  yield* Effect.addFinalizer(() => Effect.orDie(close));
  return {
    socketPath,
    call(method, params, timeoutMs = 30_000) {
      return Effect.suspend(() => {
        const conn = getActiveConnection();
        return conn ? peer.call(conn, method, params, timeoutMs) : new IpcConnectionError({ message: "no connected client" });
      });
    },
    notify(method, params) {
      return Effect.try({ try: () => {
        const conn = getActiveConnection();
        if (!conn) return false;
        sendFrame(conn, Ipc.createNotification(method, params));
        return true;
      }, catch: decodeIpcFailure("server.notify") });
    },
    useConnection(id) {
      if (connections.has(id)) activeConnectionId = id;
    },
    close: () => close,
  };
  });
}

// Cap how much of an unrecognized payload the error message echoes back.
const MAX_ERROR_PAYLOAD_CHARS = 200;

function unknownMessageError(raw: PlainValue): string {
  return `Unknown message type: ${String(JSON.stringify(raw)).slice(0, MAX_ERROR_PAYLOAD_CHARS)}`;
}

/** The offending frame's own id when it carries a string one, else "unknown". */
function extractFrameId(raw: PlainValue): string {
  if (raw !== null && typeof raw === "object" && "id" in raw) {
    const id = raw.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "unknown";
}
