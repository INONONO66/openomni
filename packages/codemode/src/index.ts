import type { CodeRunner, MachineHandle, MachineHost, MachineInfo } from "@openomni/machines";
import { Machine, NamedError } from "@openomni/protocol";
import { z } from "zod";
import { PythonKernel } from "./kernel";

type Caller = (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>;
export interface RunOptions {
  /** Hard deadline: at expiry the cell is `timed_out` and its interpreter replaced. */
  readonly timeoutMs?: number;
  /**
   * How long `run` waits for settlement before answering `running` and leaving
   * the cell in the background for `peek`/`stop`. Absent waits for settlement.
   */
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
}
/** A cell left running by `run`; kept until its settled state has been read once. */
interface BackgroundCell {
  readonly tenant: string;
  readonly machineId: string;
  readonly controller: AbortController;
  readonly execution: Promise<Machine.CellResult>;
  done: boolean;
}
/** Settled-but-unread background results retained per facade before the oldest is dropped. */
const RETAINED_SETTLED_CELLS = 64;
interface Options {
  /** Absent on a daemon runner: its calls travel back through the injected wire port. */
  readonly machines?: Pick<MachineHost, "list" | "get">;
  readonly completion?: (request: Machine.CompletionRequest) => Promise<string>;
  /** Captured synchronously at cell entry, preserving the consumer's executor context. */
  readonly tools?: (tenant: string) => Caller;
  readonly boundary?: (
    tenant: string,
  ) => (
    call: Machine.ToolCall,
    body: () => Promise<Machine.ToolCallResult>,
  ) => Promise<Machine.ToolCallResult>;
}
export const CodemodeError = NamedError.create(
  "CodemodeError",
  z.object({
    reason: z.enum([
      "closed",
      "machines_not_bound",
      "machine_not_found",
      "ambiguous_machine",
      "unknown_cell_id",
    ]),
    message: z.string(),
  }),
);
const PathInput = z.object({ machineId: Machine.MachineId, path: Machine.AbsolutePath }).strict();
const WriteInput = PathInput.extend({ data: z.string() });
const ShellInput = Machine.ExecRequest.extend({ machineId: Machine.MachineId });
const RunInput = z.object({ machineId: Machine.MachineId, code: z.string() }).strict();
const FindInput = z.object({ tag: z.string().min(1) }).strict();

/** One factory serves a brain facade and an independently injected daemon runner. */
export function createCodemode(options: Options = {}) {
  const kernels = new Map<string, PythonKernel>();
  const handles = new Map<string, ReturnType<typeof makeHandle>>();
  const live = new Map<
    string,
    {
      caller: Caller;
      tenant: string;
      timeoutMs: number;
      signal?: AbortSignal;
      boundary?: ReturnType<NonNullable<Options["boundary"]>>;
    }
  >();
  const lifetime = new AbortController();
  const running = new Set<Promise<Machine.CellResult>>();
  const background = new Map<string, BackgroundCell>();
  let closed = false;
  function requireOpen(): void {
    if (closed) throw new CodemodeError({ reason: "closed", message: "codemode is closed" });
  }
  function machines(): Pick<MachineHost, "list" | "get"> {
    requireOpen();
    if (options.machines === undefined)
      throw new CodemodeError({
        reason: "machines_not_bound",
        message: "machine port is not bound",
      });
    return options.machines;
  }
  function select(query: { tag: string }): string {
    const parsed = FindInput.parse(query);
    const found = machines()
      .list()
      .filter((entry) => entry.tags.includes(parsed.tag));
    const first = found[0];
    if (first === undefined)
      throw new CodemodeError({
        reason: "machine_not_found",
        message: "no machine matches the tag",
      });
    if (found.length > 1)
      throw new CodemodeError({
        reason: "ambiguous_machine",
        message: "multiple machines match the tag",
      });
    return first.machineId;
  }
  function makeHandle(id: string) {
    const target = (): MachineHandle => machines().get(id);
    // Handle methods are named exactly like the tools they mirror (KERNEL §3.5).
    return {
      read: (path: string) => target().fs.read(path),
      write: (path: string, data: Uint8Array) => target().fs.write(path, data),
      ls: (path: string) => target().fs.list(path),
      bash: (command: string, cwd: string) => target().exec(command, cwd),
      eval: (cell: Machine.CellRequest, signal?: AbortSignal) => target().runCode(cell, signal),
    };
  }
  function getMachine(id: string) {
    const parsed = Machine.MachineId.parse(id);
    requireOpen();
    let handle = handles.get(parsed);
    if (handle === undefined) {
      handle = makeHandle(parsed);
      handles.set(parsed, handle);
    }
    return handle;
  }

  function callTool(call: Machine.ToolCall): Promise<Machine.ToolCallResult> {
    const binding = live.get(call.cellId);
    if (binding === undefined)
      return Promise.resolve({
        status: "failed",
        error: `no tools are bound to cell ${call.cellId}`,
      });
    return binding.boundary === undefined
      ? dispatch(call)
      : binding.boundary(call, () => dispatch(call));
  }
  async function dispatch(call: Machine.ToolCall): Promise<Machine.ToolCallResult> {
    const binding = live.get(call.cellId);
    if (binding === undefined)
      throw new CodemodeError({ reason: "unknown_cell_id", message: "cell has settled" });
    if (call.name === "codemode.listMachines")
      return Machine.ToolCallResult.parse({ status: "completed", value: machines().list() });
    if (call.name === "codemode.findMachine") {
      const input = z.object({ query: FindInput }).strict().parse(call.arguments);
      return { status: "completed", value: select(input.query) };
    }
    if (call.name === "codemode.read") {
      const input = PathInput.parse(call.arguments);
      const value = await getMachine(input.machineId).read(input.path);
      return {
        status: "completed",
        value: { ...value, data: Buffer.from(value.data).toString("base64") },
      };
    }
    if (call.name === "codemode.write") {
      const input = WriteInput.parse(call.arguments);
      return {
        status: "completed",
        value: await getMachine(input.machineId).write(
          input.path,
          Buffer.from(input.data, "base64"),
        ),
      };
    }
    if (call.name === "codemode.ls") {
      const input = PathInput.parse(call.arguments);
      return { status: "completed", value: await getMachine(input.machineId).ls(input.path) };
    }
    if (call.name === "codemode.bash") {
      const input = ShellInput.parse(call.arguments);
      const value = await getMachine(input.machineId).bash(input.cmd, input.cwd);
      return {
        status: "completed",
        value:
          value.status === "completed"
            ? {
                ...value,
                stdout: Buffer.from(value.stdout).toString("base64"),
                stderr: Buffer.from(value.stderr).toString("base64"),
              }
            : value,
      };
    }
    if (call.name === "codemode.eval") {
      const input = RunInput.parse(call.arguments);
      return {
        status: "completed",
        value: await runOn(
          input.machineId,
          input.code,
          `${binding.tenant}/nested`,
          binding.caller,
          { timeoutMs: binding.timeoutMs, signal: binding.signal },
          binding.boundary,
        ),
      };
    }
    if (call.name === "completion" && options.completion !== undefined) {
      const input = Machine.CompletionRequest.parse(call.arguments);
      return { status: "completed", value: await options.completion(input) };
    }
    return binding.caller(call);
  }

  function unknownCell(): never {
    throw new CodemodeError({ reason: "unknown_cell_id", message: "no such cell" });
  }
  function tenantCell(cellId: string, tenant: string): BackgroundCell {
    const entry = background.get(cellId);
    // Another tenant's cell is as unknown as a settled one: ids never leak across sessions.
    if (entry === undefined || entry.tenant !== tenant) unknownCell();
    return entry;
  }
  /**
   * Hand the settled state over exactly once: every caller claims synchronously, right
   * after looking the entry up, so nothing can claim it between the two. A rejection
   * surfaces the same way.
   */
  function settle(cellId: string, entry: BackgroundCell): Promise<Machine.CellResult> {
    background.delete(cellId);
    return entry.execution;
  }
  function retainSettled(): void {
    const settled = [...background].filter(([, entry]) => entry.done);
    for (const [cellId] of settled.slice(0, Math.max(0, settled.length - RETAINED_SETTLED_CELLS)))
      background.delete(cellId);
  }
  async function peek(cellId: string, tenant: string): Promise<Machine.CellState> {
    requireOpen();
    const entry = tenantCell(cellId, tenant);
    if (entry.done) return settle(cellId, entry);
    const view = await machines().get(entry.machineId).peekCode(cellId);
    // A stop that claimed the cell during the round trip owns its result; here it is spent.
    if (!background.has(cellId)) unknownCell();
    if (view.running) return { status: "running", cellId, output: view.output };
    // The daemon has settled it; the result is in transit.
    return settle(cellId, entry);
  }
  async function stop(cellId: string, tenant: string): Promise<Machine.CellResult> {
    requireOpen();
    const entry = tenantCell(cellId, tenant);
    // Aborting a settled cell is a no-op on the wire; the code never runs again.
    entry.controller.abort();
    return settle(cellId, entry);
  }

  async function runOn(
    id: string,
    code: string,
    tenant: string,
    caller: Caller,
    runOptions: RunOptions,
    boundary = options.boundary?.(tenant),
  ): Promise<Machine.CellResult> {
    return launch(id, code, tenant, caller, runOptions, boundary).execution;
  }
  function launch(
    id: string,
    code: string,
    tenant: string,
    caller: Caller,
    runOptions: RunOptions,
    boundary = options.boundary?.(tenant),
  ): { cellId: string; controller: AbortController; execution: Promise<Machine.CellResult> } {
    const timeoutMs = runOptions.timeoutMs ?? 15_000;
    const cellId = crypto.randomUUID();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      lifetime.signal,
      controller.signal,
      ...(runOptions.signal === undefined ? [] : [runOptions.signal]),
    ]);
    const handle = machines().get(id);
    live.set(cellId, { caller, tenant, timeoutMs, signal, boundary });
    const execution = handle.runCode({ cellId, code, tenant, timeoutMs }, signal);
    running.add(execution);
    const cleanup = () => {
      live.delete(cellId);
      running.delete(execution);
    };
    execution.then(cleanup, cleanup);
    return { cellId, controller, execution };
  }
  const runner: CodeRunner = {
    async runCode(request, call, signal) {
      requireOpen();
      const tenant = request.tenant ?? "default";
      let kernel = kernels.get(tenant);
      if (kernel === undefined) {
        kernel = new PythonKernel();
        kernels.set(tenant, kernel);
      }
      return kernel.run(request, call, signal);
    },
    peekCode(cellId) {
      for (const kernel of kernels.values()) {
        const output = kernel.peek(cellId);
        if (output !== undefined) return output;
      }
      return undefined;
    },
    async close() {
      closed = true;
      lifetime.abort();
      await Promise.all([...kernels.values()].map((kernel) => kernel.close()));
      await Promise.allSettled([...running]);
      live.clear();
      kernels.clear();
    },
  };
  return {
    listMachines: (): MachineInfo[] => machines().list(),
    getMachine,
    findMachine: (query: { tag: string }) => getMachine(select(query)),
    callTool,
    runner,
    close: runner.close,
    cell: {
      async run(
        code: string,
        tenant: string,
        runOptions: RunOptions = {},
      ): Promise<Machine.CellState> {
        const target = machines()
          .list()
          .find((entry) => entry.capabilities.includes(Machine.WellKnownCapability.pythonKernel));
        if (target === undefined) return { status: "refused", reason: "kernel_not_available" };
        const caller =
          options.tools?.(tenant) ??
          (async () => ({ status: "failed" as const, error: "this cell exposes no tools" }));
        const started = launch(target.machineId, code, tenant, caller, runOptions);
        if (runOptions.waitMs === undefined) return started.execution;
        const entry: BackgroundCell = {
          tenant,
          machineId: target.machineId,
          controller: started.controller,
          execution: started.execution,
          done: false,
        };
        const markDone = () => {
          entry.done = true;
          retainSettled();
        };
        started.execution.then(markDone, markDone);
        background.set(started.cellId, entry);
        const settled = await within(started.execution, runOptions.waitMs).catch((error: Error) => {
          background.delete(started.cellId);
          throw error;
        });
        // The id has not been answered yet, so no peek or stop can have claimed it: the
        // launcher is the one reader even if the retention bound already evicted the entry.
        if (settled !== undefined) {
          background.delete(started.cellId);
          return settled;
        }
        return peek(started.cellId, tenant);
      },
      peek,
      stop,
    },
  };
}

/** The promise's value once it settles within `ms`, else undefined; a rejection propagates. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
