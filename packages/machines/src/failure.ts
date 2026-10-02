import { z } from "zod";
import {
  MachinesFailure,
  MachineCellError,
  MachineRefusalError,
  SpawnFailure,
  FilesystemFailure,
  TransportFailure,
  type MachineError,
} from "./errors";
import { CodemodeError, DriverFailure, type CodeError } from "./codemode/errors";
import {
  IpcConnectionError,
  IpcProtocolError,
  IpcRemoteError,
  IpcTimeoutError,
  type IpcError,
} from "./ipc/errors";

/** One fallback for every machines-owned domain: a Cause without a typed error becomes MachinesFailure. */
function machinesFallback(operation: string) {
  return z
    .preprocess(String, z.string())
    .transform((cause) => new MachinesFailure({ operation, cause }));
}

export function decodeMachineFailure(operation: string) {
  return z
    .union([
      z.instanceof(MachinesFailure),
      z.instanceof(MachineCellError),
      z.instanceof(MachineRefusalError),
      z.instanceof(SpawnFailure),
      z.instanceof(FilesystemFailure),
      z.instanceof(TransportFailure),
      machinesFallback(operation),
    ])
    .transform((error): MachineError => error).parse;
}

export function decodeIpcFailure(operation: string) {
  return z
    .union([
      z.instanceof(MachinesFailure),
      z.instanceof(IpcConnectionError),
      z.instanceof(IpcProtocolError),
      z.instanceof(IpcRemoteError),
      z.instanceof(IpcTimeoutError),
      machinesFallback(operation),
    ])
    .transform((error): IpcError => error).parse;
}

export function decodeCodeFailure(operation: string) {
  return z
    .union([
      z.instanceof(CodemodeError),
      z.instanceof(DriverFailure),
      z.instanceof(MachinesFailure),
      machinesFallback(operation),
    ])
    .transform((error): CodeError => error).parse;
}
