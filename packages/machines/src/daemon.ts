import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { type IpcClient, connectIpcClient, typedCall, ForeignFailure as IpcForeignFailure } from "@openomni/ipc";
import { Machine } from "@openomni/protocol";
import { Deferred, Effect, Exit, type Scope } from "effect";
import type { z } from "zod";
import { MachineRefusalError, TransportFailure, type MachineError } from "./errors";
import { decodeMachineFailure } from "./failure";
import { createFsDriver } from "./fs";
import { execute } from "./exec";

/** Injected native interpreter port; the acquiring app scope owns its execution. */
export interface CodeRunner {
  runCode(request: Machine.CellRequest, call: (call: Machine.ToolCall) => Effect.Effect<Machine.ToolCallResult, MachineError>, signal: AbortSignal): Effect.Effect<Machine.CellResult, MachineError>;
  peekCode(cellId: string): Machine.CellOutput | undefined;
  close(): Effect.Effect<void, MachineError>;
}
interface MachineDaemonOptions {
  readonly socketPath: string;
  readonly offer: Machine.Offer;
  readonly fsExports?: ReadonlyMap<string, string>;
  readonly runner?: CodeRunner;
  readonly attachTimeoutMs?: number;
}
type WireParse = <T>(schema: z.ZodType<T>) => T;
type WireResult = Machine.FsResult | Machine.ExecResult | Machine.CancelResult | Machine.PeekResult | Machine.CellResult;
export interface MachineDaemon {
  readonly attachment: Machine.AttachResult;
  readonly closed: Effect.Effect<void, MachineError>;
  close(): Effect.Effect<void, MachineError>;
}
function escapesCanonicalRoot(absolute: string, root: string): boolean {
  try {
    const resolved = posix.normalize(realpathSync(absolute));
    const canonical = posix.normalize(realpathSync(root));
    return resolved !== canonical && !resolved.startsWith(`${canonical}/`);
  } catch {
    // A missing path remains inside the configured root; spawn reports the I/O failure.
    return false;
  }
}

export function attachMachineDaemon(options: MachineDaemonOptions): Effect.Effect<MachineDaemon, MachineError, Scope.Scope> {
  return Effect.gen(function* () {
    const offer = yield* Effect.try({ try: () => Machine.Offer.parse(options.offer), catch: decodeMachineFailure("daemon.offer") });
    const filesystem = yield* createFsDriver(options.fsExports ?? new Map());
    const lifetime = new AbortController();
    const cells = new Map<string, AbortController>();
    const pending = new Set<Deferred.Deferred<void>>();
    let client: IpcClient | undefined;
    let attachment: Machine.AttachResult = { status: "refused", reason: "machine_not_enrolled" };
    const attached = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void, MachineError>();
    let closing = false;
    const transportFailure = (operation: string) => (error: import("@openomni/ipc").IpcError) => new TransportFailure({ operation, message: error.message || String(error), cause: String(error) });
    const close: Effect.Effect<void, MachineError> = Effect.suspend(() => {
      if (closing) return Deferred.await(closed);
      closing = true;
      lifetime.abort();
      for (const cell of cells.values()) cell.abort();
      return Effect.gen(function* () {
        yield* filesystem.close();
        if (client) yield* client.close().pipe(Effect.mapError(transportFailure("daemon.close")));
        if (options.runner) yield* options.runner.close();
        yield* Effect.forEach([...pending], Deferred.await, { discard: true });
      }).pipe(Effect.onExit((exit) => Deferred.done(closed, exit)));
    });
    yield* Effect.addFinalizer(() => Effect.orDie(close));
    function has(capability: string): boolean {
      return attachment.status === "attached" && attachment.effectiveCapabilities.includes(capability) && offer.offeredCapabilities.includes(capability);
    }
    function openCwd(cwd: string): { readonly cwd: string } | Machine.ExecResult {
      const absolute = posix.normalize(cwd);
      const allowed = attachment.status === "attached" ? attachment.effectiveExports : [];
      for (const name of allowed) {
        const offered = offer.exports?.find((entry) => entry.name === name);
        const configured = options.fsExports?.get(name);
        if (offered === undefined || configured !== offered.path) continue;
        const root = posix.normalize(offered.path).replace(/\/+$/, "") || "/";
        if (absolute !== root && !absolute.startsWith(`${root}/`)) continue;
        if (escapesCanonicalRoot(absolute, root)) return { status: "refused", reason: "path_escapes_export" };
        return { cwd: absolute };
      }
      return { status: "refused", reason: "path_escapes_export" };
    }
    function tracked<A>(execution: Effect.Effect<A, MachineError>): Effect.Effect<A, MachineError> {
      return Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        pending.add(done);
        return yield* execution.pipe(Effect.ensuring(Effect.sync(() => { pending.delete(done); Deferred.unsafeDone(done, Exit.void); })));
      });
    }
    function fsOp(request: Machine.FsRequest): Effect.Effect<Machine.FsResult, MachineError> {
      return Effect.suspend(() => {
        const capability = request.op === "write" ? Machine.WellKnownCapability.fsWrite : Machine.WellKnownCapability.fsRead;
        if (!has(capability)) return Effect.succeed({ status: "refused", reason: "fs_not_available", message: `${capability} is not available` } as const);
        const offered = offer.exports?.find((entry) => entry.name === request.export);
        if (attachment.status !== "attached" || !attachment.effectiveExports.includes(request.export) || offered === undefined || options.fsExports?.get(request.export) !== offered.path)
          return Effect.succeed({ status: "refused", reason: "export_not_available", message: `export is not available: ${request.export}` } as const);
        return filesystem(request);
      });
    }
    function exec(request: Machine.ExecRequest): Effect.Effect<Machine.ExecResult, MachineError> {
      return Effect.suspend(() => {
        if (!has(Machine.WellKnownCapability.shellExec)) return Effect.succeed({ status: "refused", reason: "exec_not_available" } as const);
        const cwd = openCwd(request.cwd);
        return "status" in cwd ? Effect.succeed(cwd) : tracked(execute({ ...request, cwd: cwd.cwd }, lifetime.signal));
      });
    }
    function cancelCode(request: z.infer<typeof Machine.CancelCode>): Machine.CancelResult {
      const cell = cells.get(request.cellId);
      cell?.abort();
      return { cancelled: cell !== undefined };
    }
    function peekCode(request: z.infer<typeof Machine.PeekCode>): Machine.PeekResult {
      return { running: cells.has(request.cellId), output: options.runner?.peekCode(request.cellId) ?? { stdout: "", stderr: "" } };
    }
    function callTool(call: Machine.ToolCall, timeoutMs: number): Effect.Effect<Machine.ToolCallResult, MachineError> {
      return Effect.suspend(() => {
        if (client === undefined) return new MachineRefusalError({ reason: "closed", message: "daemon connection is closed" });
        return typedCall(client, Machine.WireMethod.CallTool, call, timeoutMs).pipe(
          Effect.mapError(transportFailure("daemon.tool")),
          Effect.flatMap((raw) => Effect.try({ try: () => Machine.ToolCallResult.parse(raw), catch: decodeMachineFailure("daemon.tool.response") })),
        );
      });
    }
    function runCode(request: Machine.CellRequest): Effect.Effect<Machine.CellResult, MachineError> {
      return Effect.suspend(() => {
        if (!has(Machine.WellKnownCapability.pythonKernel) || options.runner === undefined) return Effect.succeed({ status: "refused", reason: "kernel_not_available" } as const);
        if (cells.has(request.cellId)) return new MachineRefusalError({ reason: "invalid_response", message: "duplicate cell id" });
        const cell = new AbortController();
        cells.set(request.cellId, cell);
        return tracked(options.runner.runCode(request, (call) => callTool(call, request.timeoutMs), cell.signal)).pipe(
          Effect.flatMap((raw) => Effect.try({ try: () => Machine.CellResult.parse(raw), catch: decodeMachineFailure("daemon.cell.response") })),
          Effect.ensuring(Effect.sync(() => { cells.delete(request.cellId); })),
        );
      });
    }
    const wire: Readonly<Record<string, ((parse: WireParse) => Effect.Effect<WireResult, MachineError>) | undefined>> = {
      [Machine.WireMethod.FsOp]: (parse) => fsOp(parse(Machine.FsRequest)),
      [Machine.WireMethod.Exec]: (parse) => exec(parse(Machine.ExecRequest)),
      [Machine.WireMethod.CancelCode]: (parse) => Effect.sync(() => cancelCode(parse(Machine.CancelCode))),
      [Machine.WireMethod.PeekCode]: (parse) => Effect.sync(() => peekCode(parse(Machine.PeekCode))),
      [Machine.WireMethod.RunCode]: (parse) => runCode(parse(Machine.CellRequest)),
    };
    return yield* Effect.gen(function* () {
      client = yield* connectIpcClient(options.socketPath, {
        onDisconnect: () => close.pipe(Effect.mapError((error) => new IpcForeignFailure({ operation: "daemon.disconnect", cause: String(error) }))),
        onRequest: (method, params, respond) => Deferred.await(attached).pipe(Effect.zipRight(Effect.gen(function* () {
          const serve = wire[method];
          if (serve === undefined) return yield* new MachineRefusalError({ reason: "invalid_method", message: `invalid method: ${method}` });
          const body = yield* Effect.try({ try: () => serve(<T>(schema: z.ZodType<T>): T => schema.parse(params)), catch: decodeMachineFailure("daemon.request") });
          respond(yield* body);
        })), Effect.mapError((error) => new IpcForeignFailure({ operation: "daemon.request", cause: error.message || String(error) }))),
      }).pipe(Effect.mapError(transportFailure("daemon.connect")));
      const raw = yield* typedCall(client, Machine.WireMethod.Attach, offer, options.attachTimeoutMs).pipe(Effect.mapError(transportFailure("daemon.attach")));
      attachment = yield* Effect.try({ try: () => Machine.AttachResult.parse(raw), catch: decodeMachineFailure("daemon.attach.response") });
      return { attachment, closed: Deferred.await(closed), close: () => close };
    }).pipe(Effect.ensuring(Deferred.succeed(attached, undefined)), Effect.onError(() => Effect.orDie(close)));
  });
}
