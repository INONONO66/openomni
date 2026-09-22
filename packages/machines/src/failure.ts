import { z } from "zod";
import { ForeignFailure, MachineCellError, MachineRefusalError, SpawnFailure, FilesystemFailure, TransportFailure, type MachineError } from "./errors";

export function decodeMachineFailure(operation: string) {
  return z.union([
    z.instanceof(ForeignFailure), z.instanceof(MachineCellError), z.instanceof(MachineRefusalError),
    z.instanceof(SpawnFailure), z.instanceof(FilesystemFailure), z.instanceof(TransportFailure),
    z.preprocess(String, z.string()).transform((cause) => new ForeignFailure({ operation, cause })),
  ]).transform((error): MachineError => error).parse;
}
