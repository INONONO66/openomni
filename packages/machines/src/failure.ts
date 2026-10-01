import { z } from "zod";
import { MachinesFailure, MachineCellError, MachineRefusalError, SpawnFailure, FilesystemFailure, TransportFailure, type MachineError } from "./errors";

export function decodeMachineFailure(operation: string) {
  return z.union([
    z.instanceof(MachinesFailure), z.instanceof(MachineCellError), z.instanceof(MachineRefusalError),
    z.instanceof(SpawnFailure), z.instanceof(FilesystemFailure), z.instanceof(TransportFailure),
    z.preprocess(String, z.string()).transform((cause) => new MachinesFailure({ operation, cause })),
  ]).transform((error): MachineError => error).parse;
}
