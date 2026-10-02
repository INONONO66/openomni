import { z } from "zod";
import { IpcFailure, IpcConnectionError, IpcProtocolError, IpcRemoteError, IpcTimeoutError, type IpcError } from "./errors";

export function decodeIpcFailure(operation: string) {
  return z.union([
    z.instanceof(IpcFailure), z.instanceof(IpcConnectionError), z.instanceof(IpcProtocolError),
    z.instanceof(IpcRemoteError), z.instanceof(IpcTimeoutError),
    z.preprocess(String, z.string()).transform((cause) => new IpcFailure({ operation, cause })),
  ]).transform((error): IpcError => error).parse;
}
