// Published protocol-only transport contract; product semantics stay in consumers.
export { connectIpcClient } from "./client";
export type { IpcClient } from "./client";
export { IpcRemoteError } from "./errors";
export { createIpcServer } from "./server";
export type { IpcServer } from "./server";
export { typedCall } from "./typed-call";
