import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { type IpcClient, connectIpcClient, typedCall } from "@openomni/ipc";
import { Machine } from "@openomni/protocol";
import { MachineRefusalError } from "./errors";
import { createFsDriver } from "./fs";
import { execute } from "./exec";

/** Injected at composition: machines never imports or owns an interpreter. */
export interface CodeRunner {
  runCode(request: Machine.CellRequest, call: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>, signal: AbortSignal): Promise<Machine.CellResult>;
  close(): Promise<void>;
}

export interface MachineDaemonOptions {
  readonly socketPath: string;
  readonly offer: Machine.Offer;
  readonly fsExports?: ReadonlyMap<string, string>;
  readonly runner?: CodeRunner;
  readonly attachTimeoutMs?: number;
}
export interface MachineDaemon {
  readonly attachment: Machine.AttachResult;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export async function attachMachineDaemon(options: MachineDaemonOptions): Promise<MachineDaemon> {
  const offer = Machine.Offer.parse(options.offer);
  const filesystem = createFsDriver(options.fsExports ?? new Map());
  const lifetime = new AbortController();
  const cells = new Map<string, AbortController>();
  const pending = new Set<Promise<Machine.CellResult | Machine.ExecResult>>();
  let client: IpcClient | undefined;
  let attachment: Machine.AttachResult = { status: "refused", reason: "machine_not_enrolled" };
  let ready!: () => void;
  const attached = new Promise<void>((resolve) => { ready = resolve; });
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing !== undefined) return closing;
    lifetime.abort();
    for (const cell of cells.values()) cell.abort();
    filesystem.close();
    client?.close();
    closing = (async () => {
      await options.runner?.close();
      await Promise.allSettled([...pending]);
    })();
    closing.then(resolveClosed, (error: Error) => rejectClosed(error));
    return closing;
  }
  function has(capability: string): boolean {
    return attachment.status === "attached" && attachment.effectiveCapabilities.includes(capability) && offer.offeredCapabilities.includes(capability);
  }
  function confinedCwd(cwd: string): boolean {
    const absolute = posix.normalize(cwd);
    for (const root of options.fsExports?.values() ?? []) {
      let canonicalRoot: string;
      try {
        canonicalRoot = posix.normalize(realpathSync(root)).replace(/\/+$/, "") || "/";
      } catch {
        continue;
      }
      if (absolute !== root && !absolute.startsWith(`${posix.normalize(root).replace(/\/+$/, "")}/`)) continue;
      try {
        const resolved = posix.normalize(realpathSync(absolute));
        if (resolved === canonicalRoot || resolved.startsWith(`${canonicalRoot}/`)) return true;
      } catch {
        // A missing cwd remains export-confined; spawn reports its typed I/O refusal.
        return true;
      }
    }
    return false;
  }
  function requireClient(): IpcClient {
    if (client === undefined) throw new MachineRefusalError({ reason: "closed", message: "daemon connection is closed" });
    return client;
  }
  try {
    client = await connectIpcClient(options.socketPath, {
      onDisconnect: () => { void close(); },
      onRequest: async (method, params, respond) => {
        await attached;
        if (method === Machine.WireMethod.FsOp) {
          const request = Machine.FsRequest.parse(params);
          const capability = request.op === "write" ? Machine.WellKnownCapability.fsWrite : Machine.WellKnownCapability.fsRead;
          if (!has(capability)) {
            respond({ status: "refused", reason: "fs_not_available", message: `${capability} is not available` } satisfies Machine.FsResult);
            return;
          }
          const offered = offer.exports?.find((entry) => entry.name === request.export);
          if (attachment.status !== "attached" || !attachment.effectiveExports.includes(request.export) || offered === undefined || options.fsExports?.get(request.export) !== offered.path) {
            respond({ status: "refused", reason: "export_not_available", message: `export is not available: ${request.export}` } satisfies Machine.FsResult);
            return;
          }
          respond(await filesystem(request));
          return;
        }
        if (method === Machine.WireMethod.Exec) {
          const request = Machine.ExecRequest.parse(params);
          if (!has(Machine.WellKnownCapability.shellExec)) {
            respond({ status: "refused", reason: "exec_not_available" } satisfies Machine.ExecResult);
            return;
          }
          if (!confinedCwd(request.cwd)) {
            respond({ status: "refused", reason: "path_escapes_export" } satisfies Machine.ExecResult);
            return;
          }
          const execution = execute(request, lifetime.signal);
          pending.add(execution);
          try { respond(await execution); } finally { pending.delete(execution); }
          return;
        }
        if (method === Machine.WireMethod.CancelCode) {
          const request = Machine.CancelCode.parse(params);
          const cell = cells.get(request.cellId);
          cell?.abort();
          respond({ cancelled: cell !== undefined } satisfies Machine.CancelResult);
          return;
        }
        if (method !== Machine.WireMethod.RunCode) throw new MachineRefusalError({ reason: "invalid_method", message: `invalid method: ${method}` });
        const request = Machine.CellRequest.parse(params);
        if (!has(Machine.WellKnownCapability.pythonKernel) || options.runner === undefined) {
          respond({ status: "refused", reason: "kernel_not_available" } satisfies Machine.CellResult);
          return;
        }
        if (cells.has(request.cellId)) throw new MachineRefusalError({ reason: "invalid_response", message: "duplicate cell id" });
        const cell = new AbortController();
        cells.set(request.cellId, cell);
        const execution = options.runner.runCode(request, async (call) => Machine.ToolCallResult.parse(await typedCall(requireClient(), Machine.WireMethod.CallTool, call, request.timeoutMs)), cell.signal);
        pending.add(execution);
        try { respond(Machine.CellResult.parse(await execution)); }
        finally { cells.delete(request.cellId); pending.delete(execution); }
      },
    });
    attachment = Machine.AttachResult.parse(await typedCall(client, Machine.WireMethod.Attach, offer, options.attachTimeoutMs));
    ready();
    return { attachment, closed, close };
  } catch (error) {
    ready();
    await close();
    throw error;
  }
}
