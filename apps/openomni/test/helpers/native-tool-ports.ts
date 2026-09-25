import { Effect, Either } from "effect";
import type { MachineHost } from "@openomni/machines";
import type { ComposedCodemode } from "../../src/composition/codemode";
import type { ToolPorts } from "../../src/tools/core/catalog";
import { runEffect } from "./effect";

async function runTyped<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Either.getOrThrowWith(await runEffect(Effect.either(effect)), (error) => error);
}

export function testMachinePorts(host: MachineHost): NonNullable<ToolPorts["machines"]> {
  return { get: (id) => {
    const handle = host.get(id);
    return {
      fs: {
        read: (path, window) => runTyped(handle.fs.read(path, window)),
        write: (path, data) => runTyped(handle.fs.write(path, data)),
        list: (path) => runTyped(handle.fs.list(path)),
        stat: (path) => runTyped(handle.fs.stat(path)),
      },
      exec: (command, cwd) => runTyped(handle.exec(command, cwd)),
    };
  } };
}

export function testCellPorts(cells: ComposedCodemode): NonNullable<ToolPorts["cells"]> {
  return {
    cell: {
      run: (code, tenant, options) => runTyped(cells.cell.run(code, tenant, options)),
      peek: (id, tenant) => runTyped(cells.cell.peek(id, tenant)),
      stop: (id, tenant) => runTyped(cells.cell.stop(id, tenant)),
    },
  };
}
