// Worker-process transport contract (#496). Protocol-only and bidirectional:
// server → owner-device reverse connections ride the same client/server pair.
// Driver-band packages (channels, remote, browser, machines, …) consume this
// barrel as a published contract; it never grows a kernel/ledger/policy import.
export { connectIpcClient, type IpcClient } from "./client";
export { IpcConnectionError, IpcProtocolError, IpcRemoteError, IpcTimeoutError } from "./errors";
export { encode } from "./framing";
export { createIpcServer, type IpcServer } from "./server";
