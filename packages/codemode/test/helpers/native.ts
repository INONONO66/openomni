import { Effect } from "effect";
import type { Machine } from "@openomni/protocol";
import { createCodemode as create } from "../../src/index";
import { PythonKernel as NativeKernel } from "../../src/kernel";
import { decodeCodeFailure } from "../../src/failure";
import type { CodeError } from "../../src/errors";
import { type CodeRunner, type MachineHost, foreign } from "../../../machines/test/helpers/native";
import { acquireSync, run } from "../../../ipc/test/helpers/effects";
export * from "../../src/errors";
export type { RunOptions } from "../../src/index";

type Caller = (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>;
type Boundary = (call: Machine.ToolCall, body: () => Promise<Machine.ToolCallResult>) => Promise<Machine.ToolCallResult>;
function code<A>(body: () => Promise<A>): Effect.Effect<A, CodeError> {
  return Effect.tryPromise({ try: body, catch: decodeCodeFailure("test.code") });
}
export class PythonKernel {
  readonly native = new NativeKernel();
  run(request: Machine.CellRequest, call: Caller, signal?: AbortSignal) { return run(this.native.run(request, (request) => foreign(() => call(request)), signal)); }
  peek(cellId: string) { return this.native.peek(cellId); }
  close() { return run(this.native.close()); }
}
export function createCodemode(options: {
  machines?: Pick<MachineHost, "list" | "get">;
  completion?: (request: Machine.CompletionRequest) => Promise<string>;
  tools?: (tenant: string) => Caller;
  boundary?: (tenant: string) => Boundary;
} = {}) {
  const completion = options.completion;
  const tools = options.tools;
  const boundary = options.boundary;
  const { value: native, close } = acquireSync(create({
    machines: options.machines ? { list: options.machines.list, get: (id) => options.machines!.get(id).native } : undefined,
    completion: completion ? (request) => code(() => completion(request)) : undefined,
    tools: tools ? (tenant) => { const call = tools(tenant); return (request) => code(() => call(request)); } : undefined,
    boundary: boundary ? (tenant) => { const decide = boundary(tenant); return (call, body) => code(() => decide(call, () => run(body()))); } : undefined,
  }));
  const runner: CodeRunner = { native: native.runner,
    runCode: (request, call, signal) => run(native.runner.runCode(request, (request) => foreign(() => call(request)), signal)),
    peekCode: native.runner.peekCode,
    close: async () => { await run(native.close()); await close(); },
  };
  type Handle = ReturnType<typeof native.getMachine>;
  function wrapHandle(handle: Handle) {
    return { read: (...args: Parameters<Handle["read"]>) => run(handle.read(...args)),
      write: (...args: Parameters<Handle["write"]>) => run(handle.write(...args)),
      ls: (...args: Parameters<Handle["ls"]>) => run(handle.ls(...args)),
      bash: (...args: Parameters<Handle["bash"]>) => run(handle.bash(...args)),
      eval: (...args: Parameters<Handle["eval"]>) => run(handle.eval(...args)),
    };
  }
  const handles = new Map<Handle, ReturnType<typeof wrapHandle>>();
  function handle(value: Handle) {
    let found = handles.get(value);
    if (!found) { found = wrapHandle(value); handles.set(value, found); }
    return found;
  }
  return { native, runner, close: runner.close, listMachines: native.listMachines,
    getMachine: (id: string) => handle(native.getMachine(id)),
    findMachine: (query: { tag: string }) => handle(native.findMachine(query)),
    callTool: (...args: Parameters<typeof native.callTool>) => run(native.callTool(...args)),
    cell: {
      run: (...args: Parameters<typeof native.cell.run>) => run(native.cell.run(...args)),
      peek: (...args: Parameters<typeof native.cell.peek>) => run(native.cell.peek(...args)),
      stop: (...args: Parameters<typeof native.cell.stop>) => run(native.cell.stop(...args)),
    },
  };
}
