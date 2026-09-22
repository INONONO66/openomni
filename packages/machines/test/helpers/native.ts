import { Effect } from "effect";
import type { Machine } from "@openomni/protocol";
import * as Native from "../../src/index";
import { createFsDriver as fsDriver } from "../../src/fs";
import { decodeMachineFailure } from "../../src/failure";
import { acquire, run, sync } from "../../../ipc/test/helpers/effects";
export * from "../../src/errors";

export function foreign<A>(body: () => Promise<A>): Effect.Effect<A, Native.MachineError> {
  return Effect.tryPromise({ try: body, catch: decodeMachineFailure("test.machine") });
}
export interface CodeRunner {
  readonly native?: Native.CodeRunner;
  runCode(request: Machine.CellRequest, call: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>, signal: AbortSignal): Promise<Machine.CellResult>;
  peekCode(cellId: string): Machine.CellOutput | undefined;
  close(): Promise<void>;
}
function nativeRunner(runner: CodeRunner): Native.CodeRunner {
  return runner.native ?? {
    runCode: (request, call, signal) => foreign(() => runner.runCode(request, (request) => run(call(request)), signal)),
    peekCode: runner.peekCode,
    close: () => foreign(() => runner.close()),
  };
}
function machineHandle(native: Native.MachineHandle) {
  return { native,
    fs: {
      read: (...args: Parameters<typeof native.fs.read>) => run(native.fs.read(...args)),
      write: (...args: Parameters<typeof native.fs.write>) => run(native.fs.write(...args)),
      list: (...args: Parameters<typeof native.fs.list>) => run(native.fs.list(...args)),
      stat: (...args: Parameters<typeof native.fs.stat>) => run(native.fs.stat(...args)),
    },
    exec: (...args: Parameters<typeof native.exec>) => run(native.exec(...args)),
    runCode: (...args: Parameters<typeof native.runCode>) => run(native.runCode(...args)),
    peekCode: (...args: Parameters<typeof native.peekCode>) => run(native.peekCode(...args)),
  };
}
export type MachineHandle = ReturnType<typeof machineHandle>;
export async function createMachineHost(options: Omit<Parameters<typeof Native.createMachineHost>[0], "callTool"> & { callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult> }) {
  const callTool = options.callTool;
  const { value: native, close } = await acquire(Native.createMachineHost({ ...options, callTool: callTool ? (call) => foreign(() => callTool(call)) : undefined }));
  const handles = new Map<string, MachineHandle>();
  return { native, list: native.list,
    get(id: string) { let handle = handles.get(id); if (!handle) { handle = machineHandle(native.get(id)); handles.set(id, handle); } return handle; },
    close: async () => { await run(native.close()); await close(); },
  };
}
export type MachineHost = Awaited<ReturnType<typeof createMachineHost>>;
export async function attachMachineDaemon(options: Omit<Parameters<typeof Native.attachMachineDaemon>[0], "runner"> & { runner?: CodeRunner }) {
  const { value: native, close } = await acquire(Native.attachMachineDaemon({ ...options, runner: options.runner ? nativeRunner(options.runner) : undefined }));
  return { native, attachment: native.attachment, get closed() { return run(native.closed); }, close: async () => { await run(native.close()); await close(); } };
}
export function createFsDriver(...args: Parameters<typeof fsDriver>) {
  const native = sync(fsDriver(...args));
  const driver = (...params: Parameters<typeof native>) => run(native(...params));
  driver.close = () => sync(native.close());
  return driver;
}
