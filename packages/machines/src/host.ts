import { chmodSync } from "node:fs";
import { posix } from "node:path";
import { type IpcServer, createIpcServer, typedCall } from "@openomni/ipc";
import { type BusEvent, Machine } from "@openomni/protocol";
import { MachineCellError, MachineRefusalError } from "./errors";

export interface MachineHostOptions {
  readonly socketPath: string;
  readonly enrollment: (id: Machine.MachineId) => Machine.Enrollment | undefined;
  readonly events: BusEvent.Sink;
  readonly now: () => number;
  readonly callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>;
}

type Value<O extends Machine.FsValue["op"]> = Extract<Machine.FsValue, { op: O }>;
type ReadValue = Omit<Value<"read">, "data"> & { readonly data: Uint8Array };
type ExecValue = Omit<Extract<Machine.ExecResult, { status: "completed" }>, "stdout" | "stderr"> & {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};
export interface MachineHandle {
  readonly fs: {
    read(path: string, window?: { offset?: number; limit?: number }): Promise<ReadValue>;
    write(path: string, data: Uint8Array): Promise<Value<"write">>;
    list(path: string): Promise<Value<"list">>;
    stat(path: string): Promise<Value<"stat">>;
  };
  exec(cmd: string, cwd: string): Promise<ExecValue | Exclude<Machine.ExecResult, { status: "completed" }>>;
  runCode(cell: Machine.CellRequest, signal?: AbortSignal): Promise<Machine.CellResult>;
}

export interface MachineInfo extends Machine.Enrollment {
  readonly tags: string[];
  readonly capabilities: string[];
  readonly os: string;
  readonly arch: string;
}

/** Structural WHERE port. Neither policy nor rendering belongs here. */
export interface MachineHost {
  list(): MachineInfo[];
  get(id: Machine.MachineId): MachineHandle;
  close(): void;
}

interface Attachment {
  readonly enrollment: Machine.Enrollment;
  readonly offer: Machine.Offer;
  readonly capabilities: readonly string[];
}

export async function createMachineHost(options: MachineHostOptions): Promise<MachineHost> {
  const attachments = new Map<string, Attachment>();
  const connectionByMachine = new Map<string, string>();
  const inFlight = new Map<string, Set<string>>();
  const handles = new Map<string, MachineHandle>();

  function detach(connectionId: string, reason: string): void {
    const attachment = attachments.get(connectionId);
    if (attachment === undefined) return;
    attachments.delete(connectionId);
    inFlight.delete(connectionId);
    if (connectionByMachine.get(attachment.offer.machineId) === connectionId) {
      connectionByMachine.delete(attachment.offer.machineId);
    }
    options.events.publish(Machine.Events.Detached, {
      machineId: attachment.offer.machineId, time: options.now(), reason,
    });
  }

  const server: IpcServer = await createIpcServer(options.socketPath, async (method, params, respond, _notify, connectionId) => {
    if (method === Machine.WireMethod.CallTool) {
      const call = Machine.ToolCall.parse(params);
      if (!attachments.has(connectionId) || !inFlight.get(connectionId)?.has(call.cellId)) {
        throw new MachineCellError({ code: "unknown_cell_id", cellId: call.cellId, message: `no cell in flight: ${call.cellId}` });
      }
      respond(options.callTool ? await options.callTool(call) : { status: "failed", error: "this host exposes no tools" } satisfies Machine.ToolCallResult);
      return;
    }
    if (method !== Machine.WireMethod.Attach) throw new MachineRefusalError({ reason: "invalid_method", message: `invalid method: ${method}` });
    const offer = Machine.Offer.parse(params);
    const found = options.enrollment(offer.machineId);
    if (found === undefined) {
      respond({ status: "refused", reason: "machine_not_enrolled" } satisfies Machine.AttachResult);
      return;
    }
    const enrollment = Machine.Enrollment.parse(found);
    const outcome = Machine.effectiveCapabilities(enrollment, offer);
    const exports = Machine.effectiveExports(enrollment, offer);
    if (outcome.kind === "machine_mismatch" || exports.kind === "machine_mismatch") {
      respond({ status: "refused", reason: "machine_mismatch" } satisfies Machine.AttachResult);
      return;
    }
    const stale = connectionByMachine.get(offer.machineId);
    if (stale !== undefined && stale !== connectionId) detach(stale, "superseded_by_reattach");
    detach(connectionId, "superseded_by_reattach");
    attachments.set(connectionId, { enrollment, offer, capabilities: outcome.capabilities });
    connectionByMachine.set(offer.machineId, connectionId);
    options.events.publish(Machine.Events.Attached, { machineId: offer.machineId, time: options.now(), effectiveCapabilities: [...outcome.capabilities] });
    respond({ status: "attached", effectiveCapabilities: [...outcome.capabilities], effectiveExports: [...exports.exports] } satisfies Machine.AttachResult);
  }, { onDisconnect: (id) => detach(id, "connection_closed") });
  chmodSync(options.socketPath, 0o600);

  function connection(id: string): { id: string; attachment: Attachment } {
    const connectionId = connectionByMachine.get(id);
    const attachment = connectionId === undefined ? undefined : attachments.get(connectionId);
    if (connectionId === undefined || attachment === undefined) throw new MachineRefusalError({ reason: "machine_not_attached", message: `machine is not attached: ${id}` });
    return { id: connectionId, attachment };
  }

  function location(id: string, path: string) {
    const peer = connection(id);
    const absolute = posix.normalize(Machine.AbsolutePath.parse(path));
    // Translation only: daemon authorization uses the negotiated export set.
    const candidates = (peer.attachment.offer.exports ?? []).map((entry) => ({ ...entry, path: posix.normalize(entry.path).replace(/\/+$/, "") || "/" })).filter((entry) => {
      return absolute === entry.path || absolute.startsWith(entry.path === "/" ? "/" : `${entry.path}/`);
    }).sort((a, b) => b.path.length - a.path.length);
    const root = candidates[0];
    if (root === undefined) throw new MachineRefusalError({ reason: "export_not_available", message: "path is outside offered exports" });
    if (candidates[1] !== undefined && candidates[1].path === root.path) throw new MachineRefusalError({ reason: "ambiguous_export", message: "multiple exports name the same root" });
    return { connectionId: peer.id, export: root.name, path: posix.relative(root.path, absolute) };
  }

  async function filesystem<O extends Machine.FsValue["op"]>(id: string, path: string, op: O, extra: { data?: string; offset?: number; limit?: number } = {}): Promise<Value<O>> {
    const target = location(id, path);
    const request = Machine.FsRequest.parse({ op, export: target.export, path: target.path, ...extra });
    server.useConnection(target.connectionId);
    const result = Machine.FsResult.parse(await typedCall(server, Machine.WireMethod.FsOp, request));
    if (result.status === "refused") throw new MachineRefusalError(result);
    if (result.value.op !== op) throw new MachineRefusalError({ reason: "invalid_response", message: "filesystem response operation mismatch" });
    return result.value as Value<O>;
  }

  function get(id: string): MachineHandle {
    const existing = handles.get(id);
    if (existing !== undefined) return existing;
    const handle: MachineHandle = {
      fs: {
        async read(path, window = {}) {
          const value = await filesystem(id, path, "read", window);
          return { ...value, data: Buffer.from(value.data, "base64") };
        },
        write: (path, data) => filesystem(id, path, "write", { data: Buffer.from(data).toString("base64") }),
        list: (path) => filesystem(id, path, "list"),
        stat: (path) => filesystem(id, path, "stat"),
      },
      async exec(cmd, cwd) {
        const peer = connection(id);
        server.useConnection(peer.id);
        const result = Machine.ExecResult.parse(await typedCall(server, Machine.WireMethod.Exec, Machine.ExecRequest.parse({ cmd, cwd }), Machine.EXEC_TIMEOUT_MS + 1000));
        return result.status === "completed" ? { ...result, stdout: Buffer.from(result.stdout, "base64"), stderr: Buffer.from(result.stderr, "base64") } : result;
      },
      async runCode(cell, signal) {
        const request = Machine.CellRequest.parse(cell);
        if (signal?.aborted) return { status: "cancelled", cellId: request.cellId };
        const peer = connection(id);
        const cells = inFlight.get(peer.id) ?? new Set<string>();
        if (cells.has(request.cellId)) throw new MachineCellError({ code: "duplicate_cell_id", cellId: request.cellId, message: `cell is already in flight: ${request.cellId}` });
        cells.add(request.cellId);
        inFlight.set(peer.id, cells);
        let cancellation: Promise<void> | undefined;
        let cancellationError: Error | undefined;
        const cancel = () => {
          if (!attachments.has(peer.id)) return;
          server.useConnection(peer.id);
          cancellation = typedCall(server, Machine.WireMethod.CancelCode, { cellId: request.cellId }).then(
            () => undefined,
            (error: Error) => { cancellationError = error; },
          );
        };
        signal?.addEventListener("abort", cancel, { once: true });
        let result: Machine.CellResult;
        try {
          server.useConnection(peer.id);
          result = Machine.CellResult.parse(await typedCall(server, Machine.WireMethod.RunCode, request, request.timeoutMs + 1000));
        } finally {
          signal?.removeEventListener("abort", cancel);
          cells.delete(request.cellId);
          await cancellation;
        }
        if (cancellationError !== undefined) throw cancellationError;
        return result;
      },
    };
    handles.set(id, handle);
    return handle;
  }

  return {
    get,
    list: () => [...attachments.values()].map(({ enrollment, offer, capabilities }) => ({
      ...structuredClone(enrollment), tags: [...(enrollment.tags ?? [])], capabilities: [...capabilities],
      os: offer.platform.split("-")[0] ?? offer.platform, arch: offer.platform.split("-").slice(1).join("-"),
    })).sort((a, b) => a.machineId.localeCompare(b.machineId)),
    close() {
      for (const id of attachments.keys()) detach(id, "host_closed");
      server.close();
    },
  };
}
