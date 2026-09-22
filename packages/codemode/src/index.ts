import { type CodeRunner, type MachineHandle, type MachineHost, type MachineInfo, type MachineError, ForeignFailure as MachineForeignFailure } from "@openomni/machines";
import { Machine } from "@openomni/protocol";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { z } from "zod";
import { PythonKernel } from "./kernel";
import { CodemodeError, type CodeError } from "./errors";
import { decodeCodeFailure } from "./failure";
export * from "./errors";
export { Codemode } from "./services";

type Failure = CodeError | MachineError;
type Caller = (call: Machine.ToolCall) => Effect.Effect<Machine.ToolCallResult, Failure>;
export interface RunOptions {
  readonly timeoutMs?: number;
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
}
interface BackgroundCell {
  readonly tenant: string;
  readonly machineId: string;
  readonly controller: AbortController;
  readonly execution: Fiber.RuntimeFiber<Machine.CellResult, Failure>;
  readonly done: boolean;
}
const RETAINED_SETTLED_CELLS = 64;
interface Options {
  readonly machines?: Pick<MachineHost, "list" | "get">;
  readonly completion?: (request: Machine.CompletionRequest) => Effect.Effect<string, Failure>;
  readonly tools?: (tenant: string) => Caller;
  readonly boundary?: (tenant: string) => (call: Machine.ToolCall, body: () => Effect.Effect<Machine.ToolCallResult, Failure>) => Effect.Effect<Machine.ToolCallResult, Failure>;
}
const PathInput = z.object({ machineId: Machine.MachineId, path: Machine.AbsolutePath }).strict();
const WriteInput = PathInput.extend({ data: z.string() });
const ShellInput = Machine.ExecRequest.extend({ machineId: Machine.MachineId });
const RunInput = z.object({ machineId: Machine.MachineId, code: z.string() }).strict();
const FindInput = z.object({ tag: z.string().min(1) }).strict();

/** One app-owned scope retains background cells and tenant interpreters. */
export function createCodemode(options: Options = {}) {
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const kernels = new Map<string, PythonKernel>();
    const handles = new Map<string, ReturnType<typeof makeHandle>>();
    const live = new Map<string, { caller: Caller; tenant: string; timeoutMs: number; signal?: AbortSignal; boundary?: ReturnType<NonNullable<Options["boundary"]>> }>();
    const lifetime = new AbortController();
    const running = new Set<Deferred.Deferred<void>>();
    const background = new Map<string, BackgroundCell>();
    let closed = false;
    function requireOpen(): void {
      if (closed) throw new CodemodeError({ reason: "closed", message: "codemode is closed" });
    }
    function machines(): Pick<MachineHost, "list" | "get"> {
      requireOpen();
      if (!options.machines) throw new CodemodeError({ reason: "machines_not_bound", message: "machine port is not bound" });
      return options.machines;
    }
    function select(query: { tag: string }): string {
      const parsed = FindInput.parse(query);
      const found = machines().list().filter((entry) => entry.tags.includes(parsed.tag));
      const first = found[0];
      if (!first) throw new CodemodeError({ reason: "machine_not_found", message: "no machine matches the tag" });
      if (found.length > 1) throw new CodemodeError({ reason: "ambiguous_machine", message: "multiple machines match the tag" });
      return first.machineId;
    }
    function makeHandle(id: string) {
      const target = (): MachineHandle => machines().get(id);
      return {
        read: (path: string) => Effect.suspend(() => target().fs.read(path)),
        write: (path: string, data: Uint8Array) => Effect.suspend(() => target().fs.write(path, data)),
        ls: (path: string) => Effect.suspend(() => target().fs.list(path)),
        bash: (command: string, cwd: string) => Effect.suspend(() => target().exec(command, cwd)),
        eval: (cell: Machine.CellRequest, signal?: AbortSignal) => Effect.suspend(() => target().runCode(cell, signal)),
      };
    }
    function getMachine(id: string) {
      const parsed = Machine.MachineId.parse(id);
      requireOpen();
      let handle = handles.get(parsed);
      if (!handle) { handle = makeHandle(parsed); handles.set(parsed, handle); }
      return handle;
    }
    function callTool(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult, Failure> {
      return Effect.suspend(() => {
        const binding = live.get(call.cellId);
        if (!binding) return Effect.succeed({ status: "failed", error: `no tools are bound to cell ${call.cellId}` } as const);
        return binding.boundary ? binding.boundary(call, () => dispatch(call)) : dispatch(call);
      });
    }
    function dispatchCatalog(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult | undefined, Failure> {
      if (call.name === "codemode.listMachines") return Effect.try({ try: () => Machine.ToolCallResult.parse({ status: "completed", value: machines().list() }), catch: decodeCodeFailure("machines.list") });
      if (call.name === "codemode.findMachine") return Effect.try({ try: (): Machine.ToolCallResult => ({ status: "completed", value: select(z.object({ query: FindInput }).strict().parse(call.arguments).query) }), catch: decodeCodeFailure("machines.find") });
      return Effect.succeed(undefined);
    }
    function dispatchMachineOp(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult | undefined, Failure> {
      return Effect.gen(function* () {
        if (call.name === "codemode.read") {
          const input = yield* Effect.try({ try: () => PathInput.parse(call.arguments), catch: decodeCodeFailure("read.arguments") });
          const value = yield* getMachine(input.machineId).read(input.path);
          return { status: "completed", value: { ...value, data: Buffer.from(value.data).toString("base64") } };
        }
        if (call.name === "codemode.write") {
          const input = yield* Effect.try({ try: () => WriteInput.parse(call.arguments), catch: decodeCodeFailure("write.arguments") });
          return { status: "completed", value: yield* getMachine(input.machineId).write(input.path, Buffer.from(input.data, "base64")) };
        }
        if (call.name === "codemode.ls") {
          const input = yield* Effect.try({ try: () => PathInput.parse(call.arguments), catch: decodeCodeFailure("ls.arguments") });
          return { status: "completed", value: yield* getMachine(input.machineId).ls(input.path) };
        }
        if (call.name === "codemode.bash") {
          const input = yield* Effect.try({ try: () => ShellInput.parse(call.arguments), catch: decodeCodeFailure("bash.arguments") });
          const value = yield* getMachine(input.machineId).bash(input.cmd, input.cwd);
          return { status: "completed", value: value.status === "completed" ? { ...value, stdout: Buffer.from(value.stdout).toString("base64"), stderr: Buffer.from(value.stderr).toString("base64") } : value };
        }
        return undefined;
      });
    }
    function dispatch(call: Machine.ToolCall): Effect.Effect<Machine.ToolCallResult, Failure> {
      return Effect.gen(function* () {
        const binding = live.get(call.cellId);
        if (!binding) return yield* new CodemodeError({ reason: "unknown_cell_id", message: "cell has settled" });
        const catalogOp = yield* dispatchCatalog(call);
        if (catalogOp !== undefined) return catalogOp;
        const machineOp = yield* dispatchMachineOp(call);
        if (machineOp !== undefined) return machineOp;
        if (call.name === "codemode.eval") {
          const input = yield* Effect.try({ try: () => RunInput.parse(call.arguments), catch: decodeCodeFailure("eval.arguments") });
          const started = yield* launch(input.machineId, input.code, `${binding.tenant}/nested`, binding.caller, { timeoutMs: binding.timeoutMs, signal: binding.signal }, binding.boundary);
          return { status: "completed", value: yield* Fiber.join(started.entry.execution) };
        }
        if (call.name === "completion" && options.completion) {
          const input = yield* Effect.try({ try: () => Machine.CompletionRequest.parse(call.arguments), catch: decodeCodeFailure("completion.arguments") });
          return { status: "completed", value: yield* options.completion(input) };
        }
        return yield* binding.caller(call);
      });
    }
    function tenantCell(cellId: string, tenant: string): BackgroundCell {
      const entry = background.get(cellId);
      if (!entry || entry.tenant !== tenant) throw new CodemodeError({ reason: "unknown_cell_id", message: "no such cell" });
      return entry;
    }
    function settle(cellId: string, entry: BackgroundCell) {
      background.delete(cellId);
      return Fiber.join(entry.execution);
    }
    function retainSettled(): void {
      const settled = [...background].filter(([, entry]) => entry.done);
      for (const [cellId] of settled.slice(0, Math.max(0, settled.length - RETAINED_SETTLED_CELLS))) background.delete(cellId);
    }
    function peek(cellId: string, tenant: string): Effect.Effect<Machine.CellState, Failure> {
      return Effect.gen(function* () {
        const entry = yield* Effect.try({ try: () => { requireOpen(); return tenantCell(cellId, tenant); }, catch: decodeCodeFailure("cell.peek") });
        if (entry.done) return yield* settle(cellId, entry);
        const view = yield* machines().get(entry.machineId).peekCode(cellId);
        if (!background.has(cellId)) return yield* new CodemodeError({ reason: "unknown_cell_id", message: "no such cell" });
        return view.running ? { status: "running", cellId, output: view.output } : yield* settle(cellId, entry);
      });
    }
    function stop(cellId: string, tenant: string): Effect.Effect<Machine.CellResult, Failure> {
      return Effect.gen(function* () {
        const entry = yield* Effect.try({ try: () => { requireOpen(); return tenantCell(cellId, tenant); }, catch: decodeCodeFailure("cell.stop") });
        entry.controller.abort();
        return yield* settle(cellId, entry);
      });
    }
    function launch(id: string, code: string, tenant: string, caller: Caller, runOptions: RunOptions, boundary = options.boundary?.(tenant)) {
      return Effect.gen(function* () {
        const timeoutMs = runOptions.timeoutMs ?? 15_000;
        const cellId = crypto.randomUUID();
        const controller = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(runOptions.signal ? [runOptions.signal] : [])]);
        const handle = yield* Effect.try({ try: () => machines().get(id), catch: decodeCodeFailure("cell.launch") });
        live.set(cellId, { caller, tenant, timeoutMs, signal, boundary });
        const settled = yield* Deferred.make<void>();
        running.add(settled);
        let done = false;
        const execution = yield* Effect.forkIn(handle.runCode({ cellId, code, tenant, timeoutMs }, signal).pipe(Effect.ensuring(Effect.sync(() => {
          done = true; live.delete(cellId); running.delete(settled); Deferred.unsafeDone(settled, Exit.void); retainSettled();
        }))), scope);
        const entry: BackgroundCell = { tenant, machineId: id, controller, execution, get done() { return done; } };
        return { cellId, entry };
      });
    }
    const runner: CodeRunner = {
      runCode: (request, call, signal) => Effect.gen(function* () {
        yield* Effect.try({ try: requireOpen, catch: decodeCodeFailure("runner.run") });
        const tenant = request.tenant ?? "default";
        let kernel = kernels.get(tenant);
        if (!kernel) { kernel = new PythonKernel(); kernels.set(tenant, kernel); }
        return yield* kernel.run(request, call, signal);
      }).pipe(Effect.mapError((error) => new MachineForeignFailure({ operation: "code.run", cause: error.message || String(error) }))),
      peekCode(cellId) {
        for (const kernel of kernels.values()) { const output = kernel.peek(cellId); if (output !== undefined) return output; }
        return undefined;
      },
      close: () => Effect.gen(function* () {
        closed = true; lifetime.abort();
        yield* Effect.forEach([...kernels.values()], (kernel) => kernel.close(), { discard: true, concurrency: "unbounded" });
        yield* Effect.forEach([...running], Deferred.await, { discard: true });
        live.clear(); kernels.clear();
      }).pipe(Effect.mapError((error) => new MachineForeignFailure({ operation: "code.close", cause: String(error) }))),
    };
    yield* Effect.addFinalizer(() => Effect.orDie(runner.close()));
    return {
      listMachines: (): MachineInfo[] => machines().list(), getMachine,
      findMachine: (query: { tag: string }) => getMachine(select(query)),
      callTool: (call: Machine.ToolCall) => callTool(call).pipe(Effect.mapError((error) => new MachineForeignFailure({ operation: "code.tool", cause: error.message || String(error) }))),
      runner, close: runner.close,
      cell: {
        run: (code: string, tenant: string, runOptions: RunOptions = {}): Effect.Effect<Machine.CellState, Failure> => Effect.gen(function* () {
          const target = yield* Effect.try({ try: () => machines().list().find((entry) => entry.capabilities.includes(Machine.WellKnownCapability.pythonKernel)), catch: decodeCodeFailure("cell.select") });
          if (!target) return { status: "refused", reason: "kernel_not_available" };
          const caller = options.tools?.(tenant) ?? (() => Effect.succeed({ status: "failed", error: "this cell exposes no tools" } as const));
          const started = yield* launch(target.machineId, code, tenant, caller, runOptions);
          if (runOptions.waitMs === undefined) return yield* Fiber.join(started.entry.execution);
          background.set(started.cellId, started.entry);
          const result = yield* Fiber.join(started.entry.execution).pipe(Effect.timeoutOption(runOptions.waitMs), Effect.onError(() => Effect.sync(() => { background.delete(started.cellId); })));
          if (result._tag === "Some") { background.delete(started.cellId); return result.value; }
          return yield* peek(started.cellId, tenant);
        }), peek, stop,
      },
    };
  });
}
