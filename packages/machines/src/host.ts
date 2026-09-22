import { chmodSync } from "node:fs";
import { posix } from "node:path";
import { createIpcServer, typedCall, ForeignFailure as IpcForeignFailure } from "@openomni/ipc";
import { type BusEvent, Machine } from "@openomni/protocol";
import { Effect, Fiber, type Scope } from "effect";
import { MachineCellError, MachineRefusalError, TransportFailure, type MachineError } from "./errors";
import { decodeMachineFailure } from "./failure";

interface MachineHostOptions {
  readonly socketPath: string;
  readonly enrollment: (id: Machine.MachineId) => Machine.Enrollment | undefined;
  readonly events: BusEvent.Sink;
  readonly now: () => number;
  readonly callTool?: (call: Machine.ToolCall) => Effect.Effect<Machine.ToolCallResult, MachineError>;
}
type Value<O extends Machine.FsValue["op"]> = Extract<Machine.FsValue, { op: O }>;
type ReadValue = Omit<Value<"read">, "data"> & { readonly data: Uint8Array };
type ExecValue = Omit<Extract<Machine.ExecResult, { status: "completed" }>, "stdout" | "stderr"> & { readonly stdout: Uint8Array; readonly stderr: Uint8Array };
export interface MachineHandle {
  readonly fs: {
    read(path: string, window?: { offset?: number; limit?: number }): Effect.Effect<ReadValue, MachineError>;
    write(path: string, data: Uint8Array): Effect.Effect<Value<"write">, MachineError>;
    list(path: string): Effect.Effect<Value<"list">, MachineError>;
    stat(path: string): Effect.Effect<Value<"stat">, MachineError>;
  };
  exec(cmd: string, cwd: string): Effect.Effect<ExecValue | Exclude<Machine.ExecResult, { status: "completed" }>, MachineError>;
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
  close(): Effect.Effect<void, MachineError>;
}
interface Attachment {
  readonly enrollment: Machine.Enrollment;
  readonly offer: Machine.Offer;
  readonly capabilities: readonly string[];
}

export function createMachineHost(options: MachineHostOptions): Effect.Effect<MachineHost, MachineError, Scope.Scope> {
  return Effect.gen(function* () {
    const attachments = new Map<string, Attachment>();
    const connectionByMachine = new Map<string, string>();
    const inFlight = new Map<string, Set<string>>();
    const handles = new Map<string, MachineHandle>();
    function detach(connectionId: string, reason: string): void {
      const attachment = attachments.get(connectionId);
      if (attachment === undefined) return;
      attachments.delete(connectionId);
      inFlight.delete(connectionId);
      if (connectionByMachine.get(attachment.offer.machineId) === connectionId) connectionByMachine.delete(attachment.offer.machineId);
      options.events.publish(Machine.Events.Detached, { machineId: attachment.offer.machineId, time: options.now(), reason });
    }
    function callTool(call: Machine.ToolCall, connectionId: string): Effect.Effect<Machine.ToolCallResult, MachineError> {
      return Effect.suspend(() => {
        if (!attachments.has(connectionId) || !inFlight.get(connectionId)?.has(call.cellId)) return new MachineCellError({ code: "unknown_cell_id", cellId: call.cellId, message: `no cell in flight: ${call.cellId}` });
        return options.callTool ? options.callTool(call) : Effect.succeed({ status: "failed", error: "this host exposes no tools" } as const);
      });
    }
    function attach(offer: Machine.Offer, respond: (result: Machine.AttachResult) => void, connectionId: string): Effect.Effect<void, MachineError> {
      return Effect.gen(function* () {
        const found = options.enrollment(offer.machineId);
        if (found === undefined) { respond({ status: "refused", reason: "machine_not_enrolled" } satisfies Machine.AttachResult); return; }
        const enrollment = yield* Effect.try({ try: () => Machine.Enrollment.parse(found), catch: decodeMachineFailure("enrollment.decode") });
        const outcome = Machine.effectiveCapabilities(enrollment, offer);
        const exports = Machine.effectiveExports(enrollment, offer);
        if (outcome.kind === "machine_mismatch" || exports.kind === "machine_mismatch") { respond({ status: "refused", reason: "machine_mismatch" } satisfies Machine.AttachResult); return; }
        const stale = connectionByMachine.get(offer.machineId);
        if (stale !== undefined && stale !== connectionId) detach(stale, "superseded_by_reattach");
        detach(connectionId, "superseded_by_reattach");
        attachments.set(connectionId, { enrollment, offer, capabilities: outcome.capabilities });
        connectionByMachine.set(offer.machineId, connectionId);
        options.events.publish(Machine.Events.Attached, { machineId: offer.machineId, time: options.now(), effectiveCapabilities: [...outcome.capabilities] });
        respond({ status: "attached", effectiveCapabilities: [...outcome.capabilities], effectiveExports: [...exports.exports] } satisfies Machine.AttachResult);
      });
    }
    const server = yield* createIpcServer(options.socketPath, (method, params, respond, _notify, connectionId) => Effect.gen(function* () {
      if (method === Machine.WireMethod.CallTool) {
        const call = yield* Effect.try({ try: () => Machine.ToolCall.parse(params), catch: decodeMachineFailure("tool.decode") });
        respond(yield* callTool(call, connectionId));
        return;
      }
      if (method !== Machine.WireMethod.Attach) return yield* new MachineRefusalError({ reason: "invalid_method", message: `invalid method: ${method}` });
      const offer = yield* Effect.try({ try: () => Machine.Offer.parse(params), catch: decodeMachineFailure("attach.decode") });
      yield* attach(offer, respond, connectionId);
    }).pipe(Effect.mapError((error) => new IpcForeignFailure({ operation: "machine.request", cause: error.message || String(error) }))), {
      onDisconnect: (id) => Effect.sync(() => detach(id, "connection_closed")),
    }).pipe(Effect.mapError((error) => new TransportFailure({ operation: "host.listen", message: error.message, cause: String(error) })));
    yield* Effect.try({ try: () => chmodSync(options.socketPath, 0o600), catch: decodeMachineFailure("host.chmod") });

    function connection(id: string): { id: string; attachment: Attachment } {
      const connectionId = connectionByMachine.get(id);
      const attachment = connectionId === undefined ? undefined : attachments.get(connectionId);
      if (connectionId === undefined || attachment === undefined) throw new MachineRefusalError({ reason: "machine_not_attached", message: `machine is not attached: ${id}` });
      return { id: connectionId, attachment };
    }
    function location(id: string, path: string) {
      const peer = connection(id);
      const absolute = posix.normalize(Machine.AbsolutePath.parse(path));
      const candidates = (peer.attachment.offer.exports ?? [])
        .map((entry) => ({ ...entry, path: posix.normalize(entry.path).replace(/\/+$/, "") || "/" }))
        .filter((entry) => absolute === entry.path || absolute.startsWith(entry.path === "/" ? "/" : `${entry.path}/`))
        .sort((a, b) => b.path.length - a.path.length);
      const root = candidates[0];
      if (root === undefined) throw new MachineRefusalError({ reason: "export_not_available", message: "path is outside offered exports" });
      if (candidates[1]?.path === root.path) throw new MachineRefusalError({ reason: "ambiguous_export", message: "multiple exports name the same root" });
      return { connectionId: peer.id, export: root.name, path: posix.relative(root.path, absolute) };
    }
    const transportFailure = (operation: string) => (error: import("@openomni/ipc").IpcError) => new TransportFailure({ operation, message: error.message || String(error), cause: String(error) });
    function filesystem<O extends Machine.FsValue["op"]>(id: string, path: string, op: O, extra: { data?: string; offset?: number; limit?: number } = {}): Effect.Effect<Value<O>, MachineError> {
      return Effect.gen(function* () {
        const target = yield* Effect.try({ try: () => location(id, path), catch: decodeMachineFailure("fs.location") });
        const request = yield* Effect.try({ try: () => Machine.FsRequest.parse({ op, export: target.export, path: target.path, ...extra }), catch: decodeMachineFailure("fs.request") });
        server.useConnection(target.connectionId);
        const raw = yield* typedCall(server, Machine.WireMethod.FsOp, request).pipe(Effect.mapError(transportFailure("fs.call")));
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
          server.useConnection(peer.id);
          const raw = yield* typedCall(server, Machine.WireMethod.Exec, request, Machine.EXEC_TIMEOUT_MS + 1000).pipe(Effect.mapError(transportFailure("exec.call")));
          const result = yield* Effect.try({ try: () => Machine.ExecResult.parse(raw), catch: decodeMachineFailure("exec.response") });
          return result.status === "completed" ? { ...result, stdout: Buffer.from(result.stdout, "base64"), stderr: Buffer.from(result.stderr, "base64") } : result;
        }),
        runCode: (cell, signal) => Effect.scoped(Effect.gen(function* () {
          const request = yield* Effect.try({ try: () => Machine.CellRequest.parse(cell), catch: decodeMachineFailure("cell.request") });
          if (signal?.aborted) return yield* Effect.interrupt;
          const peer = yield* Effect.try({ try: () => connection(id), catch: decodeMachineFailure("cell.connection") });
          const cells = inFlight.get(peer.id) ?? new Set<string>();
          if (cells.has(request.cellId)) return yield* new MachineCellError({ code: "duplicate_cell_id", cellId: request.cellId, message: `cell is already in flight: ${request.cellId}` });
          cells.add(request.cellId);
          inFlight.set(peer.id, cells);
          const cancel = Effect.suspend(() => {
            if (!attachments.has(peer.id)) return Effect.void;
            server.useConnection(peer.id);
            return typedCall(server, Machine.WireMethod.CancelCode, { cellId: request.cellId }).pipe(Effect.asVoid, Effect.mapError(transportFailure("cell.cancel")));
          });
          const cancellation = signal ? yield* Effect.forkScoped(Effect.async<void>((resume) => {
            const abort = () => resume(Effect.void);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            return Effect.sync(() => signal.removeEventListener("abort", abort));
          }).pipe(Effect.zipRight(cancel))) : undefined;
          server.useConnection(peer.id);
          return yield* typedCall(server, Machine.WireMethod.RunCode, request, request.timeoutMs + 1000).pipe(
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
          if (inFlight.get(peer.id)?.has(request.cellId) !== true) return { running: false, output: { stdout: "", stderr: "" } };
          server.useConnection(peer.id);
          const raw = yield* typedCall(server, Machine.WireMethod.PeekCode, request).pipe(Effect.mapError(transportFailure("cell.peek")));
          return yield* Effect.try({ try: () => Machine.PeekResult.parse(raw), catch: decodeMachineFailure("cell.peek.response") });
        }),
      };
      handles.set(id, handle);
      return handle;
    }
    const close = Effect.suspend(() => {
      for (const id of attachments.keys()) detach(id, "host_closed");
      return server.close().pipe(Effect.mapError(transportFailure("host.close")));
    });
    yield* Effect.addFinalizer(() => Effect.orDie(close));
    return {
      get,
      list: () => [...attachments.values()].map(({ enrollment, offer, capabilities }) => ({ ...structuredClone(enrollment), tags: [...(enrollment.tags ?? [])], capabilities: [...capabilities], os: offer.platform.split("-")[0] ?? offer.platform, arch: offer.platform.split("-").slice(1).join("-") })).sort((a, b) => a.machineId.localeCompare(b.machineId)),
      close: () => close,
    };
  });
}
