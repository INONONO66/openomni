import { expect, test } from "bun:test";
import { Context, Effect } from "effect";
import type { Ipc as Wire } from "@openomni/protocol";
import { connectIpcClient, createIpcServer, Ipc, IpcProtocolError } from "../src/index";
import { run } from "./helpers/effects";
import { socketPath } from "./helpers/socket-path";

test("the IPC service connects to its native listener and exchanges a framed request", async () => {
  const service = Context.make(Ipc, { connect: connectIpcClient, listen: createIpcServer });
  const result = await run(Effect.scoped(Effect.gen(function* () {
    const ipc = yield* Ipc;
    const server = yield* ipc.listen(socketPath("service"), (
      method: string, params: Wire.Request["params"], respond: (result: Wire.Response["result"]) => void,
    ) => Effect.sync(() => { respond({ method, params: params ?? null }); }));
    const client = yield* ipc.connect(server.socketPath);
    return yield* client.call("echo", { value: 42 });
  }).pipe(Effect.provide(service))));
  expect(result).toEqual({ method: "echo", params: { value: 42 } });
  const failure = new IpcProtocolError({ message: "malformed frame" });
  expect(await run(Effect.flip(failure))).toBe(failure);
});
