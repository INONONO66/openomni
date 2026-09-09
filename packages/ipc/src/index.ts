// Published protocol-only transport contract; product semantics stay in consumers.
export { connectIpcClient, type IpcClient } from "./client";
export { IpcRemoteError } from "./errors";
export { createIpcServer, type IpcServer } from "./server";
export { typedCall } from "./typed-call";
