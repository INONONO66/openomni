import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { type IpcClient, connectIpcClient, connectIpcTcpClient } from "./ipc";
import { makeDispatcher } from "./ipc/callbacks";
import { typedCall } from "./typed-call";
import { type Ipc, Machine } from "@openomni/protocol";
import { Deferred, Effect, Exit, Scope } from "effect";
import type { z } from "zod";
import { MachinesFailure, MachineRefusalError, TransportFailure, type MachineError } from "./errors";
import { decodeMachineFailure } from "./failure";
import { createFsDriver } from "./fs";
import { execute } from "./exec";
import { type CommandRunner, systemCommandRunner } from "./commands";
import { createComputerUse } from "./computer-use";
import { createReconnector, type ReconnectOptions } from "./reconnect";
import { createPtyAdapter } from "./pty";

/** Injected native interpreter port; the acquiring app scope owns its execution. */
export interface CodeRunner {
  runCode(request: Machine.CellRequest, call: (call: Machine.ToolCall) => Effect.Effect<Machine.ToolCallResult, MachineError>, signal: AbortSignal): Effect.Effect<Machine.CellResult, MachineError>;
  peekCode(cellId: string): Machine.CellOutput | undefined;
  close(): Effect.Effect<void, MachineError>;
}
/**
 * Where the daemon dials home (#1270): the existing Unix socket shape stays
 * top-level, or a TCP endpoint with the host's certificate and the daemon's
 * own TLS identity (PEM contents). One shape — the fields are mutually
 * exclusive.
 */
type DaemonConnection =
  | { readonly socketPath: string; readonly tcp?: undefined }
  | {
      readonly socketPath?: undefined;
      readonly tcp: { readonly host: string; readonly port: number };
      /**
       * PEM of the HOST's certificate: the TLS chain must validate against it
       * and the presented key must carry its fingerprint (#1270).
       */
      readonly hostCertificate: string;
      /** PEM contents of the daemon identity presented to mutual TLS. */
      readonly tlsCertificate: string;
      readonly tlsPrivateKey: string;
    };
type MachineDaemonOptions = DaemonConnection & {
  /** Injected request-id entropy (#1245): required, no ambient crypto fallback. */
  readonly id: () => string;
  readonly offer: Machine.Offer;
  readonly fsExports?: ReadonlyMap<string, string>;
  readonly runner?: CodeRunner;
  /** Injected shell-out port for computer-use probes/commands; tests fake it. */
  readonly commands?: CommandRunner;
  readonly attachTimeoutMs?: number;
  /**
   * Injected reconnect machinery (#1270): with it, an unexpected transport
   * loss keeps the daemon and its local drivers alive and reattaches with
   * full-jitter backoff. Absent keeps close-on-disconnect behavior.
   */
  readonly reconnect?: ReconnectOptions;
  /** Persistent terminals (#1273): tmux binary/socket overrides and test ports. */
  readonly pty?: Omit<import("./pty").PtyAdapterOptions, "id" | "runner">;
};
type WireParse = <T>(schema: z.ZodType<T>) => T;
type WireResult =
  | Machine.FsResult | Machine.ExecResult | Machine.CancelResult | Machine.PeekResult | Machine.CellResult | Machine.ScreenReadResult | Machine.InputWriteResult
  | Machine.PtyOpenResult | Machine.PtyWriteResult | Machine.PtyReadResult | Machine.PtyResizeResult | Machine.PtyCloseResult | Machine.PtyListResult;
export interface MachineDaemon {
  /** The CURRENT attachment: reattach and refusal outcomes replace it. */
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
    const configured = yield* Effect.try({ try: () => Machine.Offer.parse(options.offer), catch: decodeMachineFailure("daemon.offer") });
    const commands = options.commands ?? systemCommandRunner();
    const computer = createComputerUse({ runner: commands, id: options.id });
    const pty = createPtyAdapter({ runner: commands, id: options.id, ...options.pty });
    // Attach-time probes: computer-use needs complete prerequisites (#1274),
    // pty.session needs tmux resolving on PATH (#1273).
    const offer: Machine.Offer = { ...configured, offeredCapabilities: yield* pty.offeredCapabilities(yield* computer.offeredCapabilities(configured.offeredCapabilities)) };
    const filesystem = yield* createFsDriver(options.fsExports ?? new Map());
    const dispatch = yield* makeDispatcher;
    const lifetime = new AbortController();
    const cells = new Map<string, AbortController>();
    const pending = new Set<Deferred.Deferred<void>>();
    let client: IpcClient | undefined;
    /** Owns the CURRENT connection; each (re)connection gets a fresh scope. */
    let clientScope: Scope.Closeable | undefined;
    let attachment: Machine.AttachResult = { status: "refused", reason: "machine_not_enrolled" };
    const attached = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void, MachineError>();
    let closing = false;
    const transportFailure = (operation: string) => (error: import("./ipc").IpcError) => new TransportFailure({ operation, message: error.message || String(error), cause: String(error) });
    const releaseClient: Effect.Effect<void> = Effect.suspend(() => {
      const scope = clientScope;
      clientScope = undefined;
      client = undefined;
      return scope === undefined ? Effect.void : Scope.close(scope, Exit.void);
    });
    function runAttempt(): void {
      dispatch(attemptReattach);
    }
    const reconnector = options.reconnect === undefined ? undefined : createReconnector(options.reconnect, runAttempt);
    const close: Effect.Effect<void, MachineError> = Effect.suspend(() => {
      if (closing) return Deferred.await(closed);
      closing = true;
      reconnector?.stop();
      lifetime.abort();
      for (const cell of cells.values()) cell.abort();
      return Effect.gen(function* () {
        yield* pty.shutdown();
        yield* filesystem.close();
        yield* releaseClient;
        if (options.runner) yield* options.runner.close();
        yield* Effect.forEach([...pending], Deferred.await, { discard: true });
      }).pipe(Effect.onExit((exit) => Deferred.done(closed, exit)));
    });
    yield* Effect.addFinalizer(() => Effect.orDie(close));
    /**
     * Transport loss for ONE connection. A stale connection's late close
     * (its scope already released) is ignored; the current connection either
     * schedules a reconnect attempt (while the last attach stood) or closes
     * the daemon — a refused attachment never reconnects on its own.
     */
    function transportLoss(scope: Scope.Closeable): Effect.Effect<void, MachinesFailure> {
      return Effect.suspend(() => {
        if (closing || clientScope !== scope) return Effect.void;
        if (reconnector !== undefined && attachment.status === "attached")
          return releaseClient.pipe(Effect.andThen(Effect.sync(() => reconnector.scheduleAttempt())));
        return close.pipe(Effect.mapError((error) => new MachinesFailure({ operation: "daemon.disconnect", cause: String(error) })));
      });
    }
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
        return yield* execution.pipe(Effect.ensuring(Effect.sync(() => { pending.delete(done); Deferred.doneUnsafe(done, Exit.void); })));
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
    function screenRead(request: Machine.ScreenReadRequest): Effect.Effect<Machine.ScreenReadResult, MachineError> {
      return Effect.suspend(() => {
        if (!has(Machine.WellKnownCapability.screenRead)) return Effect.succeed({ status: "refused", reason: "screen_not_available" } as const);
        return tracked(computer.screenRead(request));
      });
    }
    function inputWrite(request: Machine.InputWriteRequest): Effect.Effect<Machine.InputWriteResult, MachineError> {
      return Effect.suspend(() => {
        if (!has(Machine.WellKnownCapability.inputWrite)) return Effect.succeed({ status: "refused", reason: "input_not_available" } as const);
        return tracked(computer.inputWrite(request));
      });
    }
    /** Shared pty gate: enrollment ∩ offer still authoritative for pty.session. */
    function ptyGuard<R extends WireResult>(body: () => Effect.Effect<R, MachineError>): Effect.Effect<R | { status: "refused"; reason: "pty_not_available" }, MachineError> {
      return Effect.suspend((): Effect.Effect<R | { status: "refused"; reason: "pty_not_available" }, MachineError> => {
        if (!has(Machine.WellKnownCapability.ptySession)) return Effect.succeed({ status: "refused", reason: "pty_not_available" } as const);
        return tracked(body());
      });
    }
    function ptyOpen(request: Machine.PtyOpenRequest): Effect.Effect<Machine.PtyOpenResult, MachineError> {
      return ptyGuard(() => {
        const cwd = openCwd(request.cwd);
        // The SAME confinement rule as exec, refused before any tmux session exists.
        if ("status" in cwd) return Effect.succeed({ status: "refused", reason: "path_escapes_export" } as const);
        return pty.open({ name: request.name, cwd: cwd.cwd });
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
      [Machine.WireMethod.ScreenRead]: (parse) => screenRead(parse(Machine.ScreenReadRequest)),
      [Machine.WireMethod.InputWrite]: (parse) => inputWrite(parse(Machine.InputWriteRequest)),
      [Machine.WireMethod.PtyOpen]: (parse) => ptyOpen(parse(Machine.PtyOpenRequest)),
      [Machine.WireMethod.PtyWrite]: (parse) => ptyGuard(() => pty.write(parse(Machine.PtyWriteRequest))),
      [Machine.WireMethod.PtyRead]: (parse) => ptyGuard(() => pty.read(parse(Machine.PtyReadRequest))),
      [Machine.WireMethod.PtyResize]: (parse) => ptyGuard(() => pty.resize(parse(Machine.PtyResizeRequest))),
      [Machine.WireMethod.PtyClose]: (parse) => ptyGuard(() => pty.close(parse(Machine.PtyCloseRequest))),
      [Machine.WireMethod.PtyList]: (parse) => ptyGuard(() => pty.list(parse(Machine.PtyListRequest))),
    };
    const onRequest = (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void) =>
      Deferred.await(attached).pipe(Effect.andThen(Effect.gen(function* () {
        const serve = wire[method];
        if (serve === undefined) return yield* new MachineRefusalError({ reason: "invalid_method", message: `invalid method: ${method}` });
        const body = yield* Effect.try({ try: () => serve(<T>(schema: z.ZodType<T>): T => schema.parse(params)), catch: decodeMachineFailure("daemon.request") });
        respond(yield* body);
      })), Effect.mapError((error) => new MachinesFailure({ operation: "daemon.request", cause: error.message || String(error) })));
    function dialWith(scope: Scope.Closeable): Effect.Effect<IpcClient, import("./ipc").IpcError, Scope.Scope> {
      const clientOptions = { idSource: options.id, onDisconnect: () => transportLoss(scope), onRequest };
      return options.tcp === undefined
        ? connectIpcClient(options.socketPath, clientOptions)
        : connectIpcTcpClient({ tcp: options.tcp, tls: { certificate: options.tlsCertificate, privateKey: options.tlsPrivateKey }, hostCertificate: options.hostCertificate }, clientOptions);
    }
    /** One connect-and-attach cycle; the connection lives in its own scope. */
    const establish: Effect.Effect<void, MachineError> = Effect.gen(function* () {
      const scope = yield* Scope.make();
      clientScope = scope;
      client = yield* dialWith(scope).pipe(Scope.provide(scope), Effect.mapError((error) =>
        // The HOST no longer passes certificate verification — chain or key —
        // against the configured hostCertificate (#1270 F5): a revocation-class
        // refusal, not a transport blip.
        error._tag === "IpcPeerKeyMismatchError"
          ? new MachineRefusalError({ reason: "peer_key_mismatch", message: error.message })
          : transportFailure("daemon.connect")(error)));
      const raw = yield* typedCall(client, Machine.WireMethod.Attach, offer, options.attachTimeoutMs).pipe(Effect.mapError(transportFailure("daemon.attach")));
      attachment = yield* Effect.try({ try: () => Machine.AttachResult.parse(raw), catch: decodeMachineFailure("daemon.attach.response") });
    });
    /**
     * A scheduled reconnect attempt. Success resets the backoff counter; a
     * REFUSED reattach surfaces through `attachment` and closes the daemon —
     * automatic reconnect stops until a restart or config change. A host
     * certificate that stopped verifying (chain or key) is equally terminal
     * (#1270 F5): the refusal surfaces and the daemon closes — certificate
     * rotation needs new config.
     * Any other transport failure releases the half-made connection and backs
     * off. The failed in-flight calls of the dropped connection are never
     * replayed.
     */
    const attemptReattach: Effect.Effect<void> = Effect.suspend(() => {
      if (closing) return Effect.void;
      return establish.pipe(
        Effect.flatMap(() => attachment.status === "attached" ? Effect.sync(() => reconnector?.reset()) : Effect.orDie(close)),
        Effect.catch((error) => {
          if (error._tag === "MachineRefusalError" && error.reason === "peer_key_mismatch") {
            attachment = { status: "refused", reason: "peer_key_mismatch" };
            return Effect.orDie(close);
          }
          return releaseClient.pipe(Effect.andThen(Effect.sync(() => { if (!closing) reconnector?.scheduleAttempt(); })));
        }),
      );
    });
    return yield* Effect.gen(function* () {
      yield* establish;
      return { get attachment() { return attachment; }, closed: Deferred.await(closed), close: () => close };
    }).pipe(Effect.ensuring(Deferred.succeed(attached, undefined)), Effect.onError(() => Effect.orDie(close)));
  });
}
