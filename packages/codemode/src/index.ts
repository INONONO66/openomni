import type { CodeRunner, MachineHandle, MachineHost, MachineInfo } from "@openomni/machines";
import { Machine, NamedError } from "@openomni/protocol";
import { z } from "zod";
import { PythonKernel } from "./kernel";

type Caller = (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>;
export interface RunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
interface Options {
  /** Absent on a daemon runner: its calls travel back through the injected wire port. */
  readonly machines?: Pick<MachineHost, "list" | "get">;
  readonly llm?: (prompts: string[]) => Promise<string[]>;
  /** Captured synchronously at cell entry, preserving the consumer's executor context. */
  readonly tools?: (tenant: string) => Caller;
  readonly boundary?: (
    tenant: string,
  ) => (
    call: Machine.ToolCall,
    body: () => Promise<Machine.ToolCallResult>,
  ) => Promise<Machine.ToolCallResult>;
}
const CodemodeError = NamedError.create(
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
    return {
      read: (path: string) => target().fs.read(path),
      write: (path: string, data: Uint8Array) => target().fs.write(path, data),
      list: (path: string) => target().fs.list(path),
      stat: (path: string) => target().fs.stat(path),
      shell: (cmd: string, cwd: string) => target().exec(cmd, cwd),
      run: (cell: Machine.CellRequest, signal?: AbortSignal) => target().runCode(cell, signal),
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
    if (call.name === "codemode.list" || call.name === "codemode.stat") {
      const input = PathInput.parse(call.arguments);
      const handle = getMachine(input.machineId);
      return {
        status: "completed",
        value: await (call.name === "codemode.list"
          ? handle.list(input.path)
          : handle.stat(input.path)),
      };
    }
    if (call.name === "codemode.shell") {
      const input = ShellInput.parse(call.arguments);
      const value = await getMachine(input.machineId).shell(input.cmd, input.cwd);
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
    if (call.name === "codemode.run") {
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
    if (call.name === "llm" && options.llm !== undefined) {
      const input = z
        .object({ prompts: z.array(z.string()).min(1) })
        .strict()
        .parse(call.arguments);
      return { status: "completed", value: await options.llm(input.prompts) };
    }
    return binding.caller(call);
  }

  async function runOn(
    id: string,
    code: string,
    tenant: string,
    caller: Caller,
    runOptions: RunOptions,
    boundary = options.boundary?.(tenant),
  ): Promise<Machine.CellResult> {
    const timeoutMs = runOptions.timeoutMs ?? 15_000;
    const cellId = crypto.randomUUID();
    const signal =
      runOptions.signal === undefined
        ? lifetime.signal
        : AbortSignal.any([lifetime.signal, runOptions.signal]);
    live.set(cellId, { caller, tenant, timeoutMs, signal, boundary });
    const execution = machines().get(id).runCode({ cellId, code, tenant, timeoutMs }, signal);
    running.add(execution);
    try {
      return await execution;
    } finally {
      live.delete(cellId);
      running.delete(execution);
    }
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
      run(code: string, tenant: string, runOptions: RunOptions = {}): Promise<Machine.CellResult> {
        const target = machines()
          .list()
          .find((entry) => entry.capabilities.includes(Machine.WellKnownCapability.pythonKernel));
        if (target === undefined)
          return Promise.resolve({ status: "refused", reason: "kernel_not_available" });
        const caller =
          options.tools?.(tenant) ??
          (async () => ({ status: "failed" as const, error: "this cell exposes no tools" }));
        return runOn(target.machineId, code, tenant, caller, runOptions);
      },
    },
  };
}
