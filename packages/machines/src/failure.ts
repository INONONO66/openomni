import { MachinesFailure, MachineCellError, MachineRefusalError, SpawnFailure, FilesystemFailure, TransportFailure, type MachineError } from "./errors";
import { IpcConnectionError, IpcPeerKeyMismatchError, IpcProtocolError, IpcRemoteError, IpcTimeoutError, type IpcError } from "./ipc/errors";

/** One fallback for every machines-owned domain (including `@openomni/codemode`): a Cause without a typed error becomes MachinesFailure. */
export function machinesFallback(operation: string) {
  return (cause: unknown) => new MachinesFailure({ operation, cause: String(cause) });
}

export function decodeMachineFailure(operation: string) {
  return (error: unknown): MachineError =>
    error instanceof MachinesFailure || error instanceof MachineCellError || error instanceof MachineRefusalError || error instanceof SpawnFailure || error instanceof FilesystemFailure || error instanceof TransportFailure ? error : machinesFallback(operation)(error);
}

export function decodeIpcFailure(operation: string) {
  return (error: unknown): IpcError =>
    error instanceof MachinesFailure || error instanceof IpcConnectionError || error instanceof IpcProtocolError || error instanceof IpcRemoteError || error instanceof IpcTimeoutError || error instanceof IpcPeerKeyMismatchError ? error : machinesFallback(operation)(error);
}
