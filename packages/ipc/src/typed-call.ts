import type { Ipc } from "@openomni/protocol";
import type { IpcClient } from "./client";

type MethodTable = typeof Ipc.Methods;
type MethodName = keyof MethodTable;
type MethodParams<Method extends MethodName> = MethodTable[Method]["params"]["_input"];
type MethodResult<Method extends MethodName> = MethodTable[Method]["result"]["_output"];

type GenericIpcCaller = Pick<IpcClient, "call">;

/**
 * Schema-derived facade for same-version methods. The caller's generic call
 * remains available for unknown methods used by mixed-version peers.
 */
export function typedCall<Method extends MethodName>(
  caller: GenericIpcCaller,
  method: Method,
  params: MethodParams<Method>,
  timeoutMs?: number,
): Promise<MethodResult<Method>> {
  return caller.call(method, params, timeoutMs) as Promise<MethodResult<Method>>;
}
