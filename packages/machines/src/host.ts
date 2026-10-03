import { chmodSync } from "node:fs";
import { posix } from "node:path";
import { createIpcServer, createIpcTcpServer, type IpcServer, type IpcTlsIdentity } from "./ipc";
import { typedCall } from "./typed-call";
import { type BusEvent, type Ipc, Machine } from "@openomni/protocol";
import { Effect, Fiber, type Scope } from "effect";
import { MachinesFailure, MachineCellError, MachineRefusalError, TransportFailure, type MachineError } from "./errors";
import { decodeMachineFailure } from "./failure";
import { onAbort } from "./interrupt-on";

interface MachineHostOptions {
  /**
   * The additive listener set (#1270): at least one of `unix` or `tcp`. Both
   * listeners serve the SAME attachment registry and request dispatcher.
   */
  readonly listen: {
    readonly unix?: string;
    readonly tcp?: { readonly host: string; readonly port: number };
  };
  /** Host TLS identity presented on the TCP listener; required when tcp is set. */
  readonly tls?: IpcTlsIdentity;
  /** Injected request-id entropy (#1245): required, no ambient crypto fallback. */
  readonly id: () => string;
  readonly enrollment: (id: Machine.MachineId) => Machine.Enrollment | undefined;
  readonly events: BusEvent.Sink;
  readonly now: () => number;
  readonly callTool?: (call: Machine.ToolCall) => Effect.Effect<Machine.ToolCallResult, MachineError>;
}
type Value<O extends Machine.FsValue["op"]> = Extract<Machine.FsValue, { op: O }>;
type ReadValue = Omit<Value<"read">, "data"> & { readonly data: Uint8Array };
type ExecValue = Omit<Extract<Machine.ExecResult, { status: "completed" }>, "stdout" | "stderr"> & { readonly stdout: Uint8Array; readonly stderr: Uint8Array };
type ScreenValue = Omit<Extract<Machine.ScreenReadResult, { status: "ok" }>, "png"> & { readonly png: Uint8Array };
export interface MachineHandle {
  readonly fs: {
    read(path: string, window?: { offset?: number; limit?: number }): Effect.Effect<ReadValue, MachineError>;
    write(path: string, data: Uint8Array): Effect.Effect<Value<"write">, MachineError>;
    list(path: string): Effect.Effect<Value<"list">, MachineError>;
    stat(path: string): Effect.Effect<Value<"stat">, MachineError>;
  };
  exec(cmd: string, cwd: string): Effect.Effect<ExecValue | Exclude<Machine.ExecResult, { status: "completed" }>, MachineError>;
  /** Computer use (#1274): bounded capture and guarded input over the same attachment. */
  screen(request: Machine.ScreenReadRequest): Effect.Effect<ScreenValue | Exclude<Machine.ScreenReadResult, { status: "ok" }>, MachineError>;
  input(request: Machine.InputWriteRequest): Effect.Effect<Machine.InputWriteResult, MachineError>;
  runCode(cell: Machine.CellRequest, signal?: AbortSignal): Effect.Effect<Machine.CellResult, MachineError>;
  peekCode(cellId: string): Effect.Effect<Machine.PeekResult, MachineError>;
}
export interface MachineInfo extends Machine.Enrollment {
  readonly tags: string[];
  readonly capabilities: string[];
  readonly os: string;
  readonly arch: string;
}
export interface MachineHost {
  list(): MachineInfo[];
  get(id: Machine.MachineId): MachineHandle;
  /** The bound endpoints — tcp carries the REAL port when the spec asked for 0. */
  readonly endpoints: {
    readonly unix?: string;
    readonly tcp?: { readonly host: string; readonly port: number };
  };
  close(): Effect.Effect<void, MachineError>;
}
/** The per-connection transport surface every machine operation routes through. */
type HostListener = Pick<IpcServer, "call" | "useConnection" | "peerFingerprintOf">;
interface Attachment {
  readonly enrollment: Machine.Enrollment;
  readonly offer: Machine.Offer;
  readonly capabilities: readonly string[];
  /** Registry key: `<listener label>:<listener connection id>` — unique across listeners. */
  readonly key: string;
  /** The listener-local connection id `server` understands. */
  readonly rawId: string;
  readonly server: HostListener;
}
/** Where a request physically arrived; the handler judges, the transport reports. */
interface RequestSource {
  readonly key: string;
  readonly rawId: string;
  readonly server: HostListener;
}

export function createMachineHost(options: MachineHostOptions): Effect.Effect<MachineHost, MachineError, Scope.Scope> {
  return Effect.gen(function* () {
    const attachments = new Map<string, Attachment>();
    const connectionByMachine = new Map<string, string>();
    /** Machines that attached at least once: their detached window reads `disconnected`. */
    const known = new Set<string>();
    const inFlight = new Map<string, Set<string>>();
    const handles = new Map<string, MachineHandle>();
    function detach(key: string, reason: string): void {
      const attachment = attachments.get(key);
      if (attachment === undefined) return;
      attachments.delete(key);
      inFlight.delete(key);
      if (connectionByMachine.get(attachment.offer.machineId) === key) connectionByMachine.delete(attachment.offer.machineId);
      options.events.publish(Machine.Events.Detached, { machineId: attachment.offer.machineId, time: options.now(), reason });
    }
    function callTool(call: Machine.ToolCall, key: string): Effect.Effect<Machine.ToolCallResult, MachineError> {
      return Effect.suspend(() => {
        if (!attachments.has(key) || !inFlight.get(key)?.has(call.cellId)) return new MachineCellError({ code: "unknown_cell_id", cellId: call.cellId, message: `no cell in flight: ${call.cellId}` });
        return options.callTool ? options.callTool(call) : Effect.succeed({ status: "failed", error: "this host exposes no tools" } as const);
      });
    }
    function attach(offer: Machine.Offer, respond: (result: Machine.AttachResult) => void, source: RequestSource): Effect.Effect<void, MachineError> {
      return Effect.gen(function* () {
        const found = options.enrollment(offer.machineId);
        if (found === undefined) { respond({ status: "refused", reason: "machine_not_enrolled" } satisfies Machine.AttachResult); return; }
        const enrollment = yield* Effect.try({ try: () => Machine.Enrollment.parse(found), catch: decodeMachineFailure("enrollment.decode") });
        // Pinned admission (#1270): a TCP peer is judged by its mutual-TLS key
        // BEFORE anything else about the offer is honored. A mismatch admits
        // nothing — the currently valid attachment (if any) stays authoritative.
        const presented = source.server.peerFingerprintOf(source.rawId);
        if (presented !== undefined && presented !== enrollment.publicKey) { respond({ status: "refused", reason: "peer_key_mismatch" } satisfies Machine.AttachResult); return; }
        const outcome = Machine.effectiveCapabilities(enrollment, offer);
        const exports = Machine.effectiveExports(enrollment, offer);
        if (outcome.kind === "machine_mismatch" || exports.kind === "machine_mismatch") { respond({ status: "refused", reason: "machine_mismatch" } satisfies Machine.AttachResult); return; }
        const stale = connectionByMachine.get(offer.machineId);
        if (stale !== undefined && stale !== source.key) detach(stale, "superseded_by_reattach");
        detach(source.key, "superseded_by_reattach");
        attachments.set(source.key, { enrollment, offer, capabilities: outcome.capabilities, ...source });
        connectionByMachine.set(offer.machineId, source.key);
        known.add(offer.machineId);
        options.events.publish(Machine.Events.Attached, { machineId: offer.machineId, time: options.now(), effectiveCapabilities: [...outcome.capabilities] });
        respond({ status: "attached", effectiveCapabilities: [...outcome.capabilities], effectiveExports: [...exports.exports] } satisfies Machine.AttachResult);
      });
    }
    function dispatchRequest(method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void, source: RequestSource): Effect.Effect<void, MachinesFailure> {
      return Effect.gen(function* () {
        if (method === Machine.WireMethod.CallTool) {
          const call = yield* Effect.try({ try: () => Machine.ToolCall.parse(params), catch: decodeMachineFailure("tool.decode") });
          respond(yield* callTool(call, source.key));
          return;
        }
        if (method !== Machine.WireMethod.Attach) return yield* new MachineRefusalError({ reason: "invalid_method", message: `invalid method: ${method}` });
        const offer = yield* Effect.try({ try: () => Machine.Offer.parse(params), catch: decodeMachineFailure("attach.decode") });
        yield* attach(offer, respond, source);
      }).pipe(Effect.mapError((error) => new MachinesFailure({ operation: "machine.request", cause: error.message || String(error) })));
    }
    /**
     * One shared dispatcher behind every listener. The label prefixes
     * listener-local connection ids so two listeners can never collide in the
     * shared registry; `bind` runs before the listener accepts a connection.
     */
    function makeListener(label: string) {
      let api: HostListener;
      return {
        handler: (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void, _notify: (method: string, params?: Ipc.Notification["params"]) => void, rawId: string) =>
          dispatchRequest(method, params, respond, { key: `${label}:${rawId}`, rawId, server: api }),
        onDisconnect: (rawId: string) => Effect.sync(() => detach(`${label}:${rawId}`, "connection_closed")),
        bind<S extends HostListener>(server: S): S { api = server; return server; },
      };
    }
    const bindFailure = (error: import("./ipc").IpcError) => new TransportFailure({ operation: "host.listen", message: error.message, cause: String(error) });
    const tcpSpec = options.listen.tcp === undefined || options.tls === undefined ? undefined : { ...options.listen.tcp, tls: options.tls };
    if (options.listen.unix === undefined && options.listen.tcp === undefined)
      return yield* new MachinesFailure({ operation: "host.listen", cause: "machines.listen requires at least one of unix or tcp" });
    if (options.listen.tcp !== undefined && tcpSpec === undefined)
      return yield* new MachinesFailure({ operation: "host.listen", cause: "a tcp listener requires the host tls identity (certificate and privateKey)" });
    const servers: Array<Pick<IpcServer, "close">> = [];
    const unixPath = options.listen.unix;
    if (unixPath !== undefined) {
      const listener = makeListener("unix");
      servers.push(listener.bind(yield* createIpcServer(unixPath, listener.handler, { idSource: options.id, onDisconnect: listener.onDisconnect }).pipe(Effect.mapError(bindFailure))));
      yield* Effect.try({ try: () => chmodSync(unixPath, 0o600), catch: decodeMachineFailure("host.chmod") });
    }
    let tcpBound: { readonly host: string; readonly port: number } | undefined;
    if (tcpSpec !== undefined) {
      const listener = makeListener("tcp");
      const server = listener.bind(yield* createIpcTcpServer(tcpSpec, listener.handler, { idSource: options.id, onDisconnect: listener.onDisconnect }).pipe(Effect.mapError(bindFailure)));
      servers.push(server);
      tcpBound = { host: server.host, port: server.port };
    }

    function connection(id: string): Attachment {
      const key = connectionByMachine.get(id);
      const attachment = key === undefined ? undefined : attachments.get(key);
      if (attachment === undefined) {
        if (known.has(id)) throw new MachineRefusalError({ reason: "disconnected", message: `machine is disconnected: ${id}` });
        throw new MachineRefusalError({ reason: "machine_not_attached", message: `machine is not attached: ${id}` });
      }
      return attachment;
    }
    function location(id: string, path: string) {
      const peer = connection(id);
      const absolute = posix.normalize(Machine.AbsolutePath.parse(path));
      const candidates = (peer.offer.exports ?? [])
        .map((entry) => ({ ...entry, path: posix.normalize(entry.path).replace(/\/+$/, "") || "/" }))
        .filter((entry) => absolute === entry.path || absolute.startsWith(entry.path === "/" ? "/" : `${entry.path}/`))
        .sort((a, b) => b.path.length - a.path.length);
      const root = candidates[0];
      if (root === undefined) throw new MachineRefusalError({ reason: "export_not_available", message: "path is outside offered exports" });
      if (candidates[1]?.path === root.path) throw new MachineRefusalError({ reason: "ambiguous_export", message: "multiple exports name the same root" });
      return { peer, export: root.name, path: posix.relative(root.path, absolute) };
    }
    // A call that dies WITH its connection is the typed reconnect-window
    // refusal (#1270), never a transport diagnostic: it settles exactly once
    // and is never replayed.
    const transportFailure = (operation: string) => (error: import("./ipc").IpcError): MachineError =>
      error._tag === "IpcConnectionError"
        ? new MachineRefusalError({ reason: "disconnected", message: error.message || "connection closed" })
        : new TransportFailure({ operation, message: error.message || String(error), cause: String(error) });
    function filesystem<O extends Machine.FsValue["op"]>(id: string, path: string, op: O, extra: { data?: string; offset?: number; limit?: number } = {}): Effect.Effect<Value<O>, MachineError> {
      return Effect.gen(function* () {
        const target = yield* Effect.try({ try: () => location(id, path), catch: decodeMachineFailure("fs.location") });
        const request = yield* Effect.try({ try: () => Machine.FsRequest.parse({ op, export: target.export, path: target.path, ...extra }), catch: decodeMachineFailure("fs.request") });
        target.peer.server.useConnection(target.peer.rawId);
        const raw = yield* typedCall(target.peer.server, Machine.WireMethod.FsOp, request).pipe(Effect.mapError(transportFailure("fs.call")));
        const result = yield* Effect.try({ try: () => Machine.FsResult.parse(raw), catch: decodeMachineFailure("fs.response") });
        if (result.status === "refused") return yield* new MachineRefusalError(result);
        if (result.value.op !== op) return yield* new MachineRefusalError({ reason: "invalid_response", message: "filesystem response operation mismatch" });
        return result.value as Value<O>;
      });
    }
    function get(id: string): MachineHandle {
      const existing = handles.get(id);
      if (existing !== undefined) return existing;
      const handle: MachineHandle = {
        fs: {
          read: (path, window = {}) => filesystem(id, path, "read", window).pipe(Effect.map((value) => ({ ...value, data: Buffer.from(value.data, "base64") }))),
          write: (path, data) => filesystem(id, path, "write", { data: Buffer.from(data).toString("base64") }),
          list: (path) => filesystem(id, path, "list"), stat: (path) => filesystem(id, path, "stat"),
        },
        exec: (cmd, cwd) => Effect.gen(function* () {
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("exec.connection") });
          const request = yield* Effect.try({ try: () => Machine.ExecRequest.parse({ cmd, cwd }), catch: decodeMachineFailure("exec.request") });
          peer.server.useConnection(peer.rawId);
          const raw = yield* typedCall(peer.server, Machine.WireMethod.Exec, request, Machine.EXEC_TIMEOUT_MS + 1000).pipe(Effect.mapError(transportFailure("exec.call")));
          const result = yield* Effect.try({ try: () => Machine.ExecResult.parse(raw), catch: decodeMachineFailure("exec.response") });
          return result.status === "completed" ? { ...result, stdout: Buffer.from(result.stdout, "base64"), stderr: Buffer.from(result.stderr, "base64") } : result;
        }),
        screen: (request) => Effect.gen(function* () {
          const parsed = yield* Effect.try({ try: () => Machine.ScreenReadRequest.parse(request), catch: decodeMachineFailure("screen.request") });
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("screen.connection") });
          peer.server.useConnection(peer.rawId);
          const raw = yield* typedCall(peer.server, Machine.WireMethod.ScreenRead, parsed, Machine.EXEC_TIMEOUT_MS + 1000).pipe(Effect.mapError(transportFailure("screen.call")));
          const result = yield* Effect.try({ try: () => Machine.ScreenReadResult.parse(raw), catch: decodeMachineFailure("screen.response") });
          return result.status === "ok" ? { ...result, png: Buffer.from(result.png, "base64") } : result;
        }),
        input: (request) => Effect.gen(function* () {
          const parsed = yield* Effect.try({ try: () => Machine.InputWriteRequest.parse(request), catch: decodeMachineFailure("input.request") });
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("input.connection") });
          peer.server.useConnection(peer.rawId);
          const raw = yield* typedCall(peer.server, Machine.WireMethod.InputWrite, parsed, Machine.EXEC_TIMEOUT_MS + 1000).pipe(Effect.mapError(transportFailure("input.call")));
          return yield* Effect.try({ try: () => Machine.InputWriteResult.parse(raw), catch: decodeMachineFailure("input.response") });
        }),
        runCode: (cell, signal) => Effect.scoped(Effect.gen(function* () {
          const request = yield* Effect.try({ try: () => Machine.CellRequest.parse(cell), catch: decodeMachineFailure("cell.request") });
          if (signal?.aborted) return yield* Effect.interrupt;
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("cell.connection") });
          const cells = inFlight.get(peer.key) ?? new Set<string>();
          if (cells.has(request.cellId)) return yield* new MachineCellError({ code: "duplicate_cell_id", cellId: request.cellId, message: `cell is already in flight: ${request.cellId}` });
          cells.add(request.cellId);
          inFlight.set(peer.key, cells);
          const cancel = Effect.suspend(() => {
            if (!attachments.has(peer.key)) return Effect.void;
            peer.server.useConnection(peer.rawId);
            return typedCall(peer.server, Machine.WireMethod.CancelCode, { cellId: request.cellId }).pipe(Effect.asVoid, Effect.mapError(transportFailure("cell.cancel")));
          });
          const cancellation = signal ? yield* Effect.forkScoped(onAbort(signal, Effect.void).pipe(Effect.andThen(cancel))) : undefined;
          peer.server.useConnection(peer.rawId);
          return yield* typedCall(peer.server, Machine.WireMethod.RunCode, request, request.timeoutMs + 1000).pipe(
            Effect.mapError(transportFailure("cell.call")),
            Effect.flatMap((raw) => Effect.try({ try: () => Machine.CellResult.parse(raw), catch: decodeMachineFailure("cell.response") })),
            Effect.tap(() => cancellation && signal?.aborted ? Fiber.join(cancellation) : Effect.void),
            Effect.onInterrupt(() => Effect.orDie(cancel)),
            Effect.ensuring(Effect.sync(() => { cells.delete(request.cellId); })),
          );
        })),
        peekCode: (cellId) => Effect.gen(function* () {
          const request = yield* Effect.try({ try: () => Machine.PeekCode.parse({ cellId }), catch: decodeMachineFailure("cell.peek.request") });
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("cell.peek.connection") });
          if (inFlight.get(peer.key)?.has(request.cellId) !== true) return { running: false, output: { stdout: "", stderr: "" } };
          peer.server.useConnection(peer.rawId);
          const raw = yield* typedCall(peer.server, Machine.WireMethod.PeekCode, request).pipe(Effect.mapError(transportFailure("cell.peek")));
          return yield* Effect.try({ try: () => Machine.PeekResult.parse(raw), catch: decodeMachineFailure("cell.peek.response") });
        }),
      };
      handles.set(id, handle);
      return handle;
    }
    const close = Effect.suspend(() => {
      for (const key of attachments.keys()) detach(key, "host_closed");
      return Effect.forEach(servers, (server) => server.close(), { discard: true }).pipe(Effect.mapError(transportFailure("host.close")));
    });
    yield* Effect.addFinalizer(() => Effect.orDie(close));
    return {
      get,
      endpoints: { ...(unixPath === undefined ? {} : { unix: unixPath }), ...(tcpBound === undefined ? {} : { tcp: tcpBound }) },
      list: () => [...attachments.values()].map(({ enrollment, offer, capabilities }) => ({ ...structuredClone(enrollment), tags: [...(enrollment.tags ?? [])], capabilities: [...capabilities], os: offer.platform.split("-")[0] ?? offer.platform, arch: offer.platform.split("-").slice(1).join("-") })).sort((a, b) => a.machineId.localeCompare(b.machineId)),
      close: () => close,
    };
  });
}
