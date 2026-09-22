import { z } from "zod";
import { ForeignFailure, IpcConnectionError, IpcProtocolError, IpcRemoteError, IpcTimeoutError, type IpcError } from "./errors";

export function decodeIpcFailure(operation: string) {
  return z.union([
    z.instanceof(ForeignFailure), z.instanceof(IpcConnectionError), z.instanceof(IpcProtocolError),
    z.instanceof(IpcRemoteError), z.instanceof(IpcTimeoutError),
    z.preprocess(String, z.string()).transform((cause) => new ForeignFailure({ operation, cause })),
  ]).transform((error): IpcError => error).parse;
}
