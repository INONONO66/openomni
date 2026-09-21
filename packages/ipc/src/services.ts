import { Context } from "effect";
import type { connectIpcClient } from "./client";
import type { createIpcServer } from "./server";

export class Ipc extends Context.Tag("@openomni/ipc/Ipc")<Ipc, {
  readonly connect: typeof connectIpcClient;
  readonly listen: typeof createIpcServer;
}>() {}
