import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { connectIpcClient } from "../src/client";
import { IpcConnectionError, IpcRemoteError } from "../src/errors";
import { createIpcServer } from "../src/server";

function tmpSocketPath(label: string): string {
  return path.join(os.tmpdir(), `omo-ipc-remote-${label}-${process.pid}.sock`);
}

describe("client remote-error path (#606 audit)", () => {
  const servers: ReturnType<typeof createIpcServer>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  test("an error frame REJECTS the call as IpcRemoteError — never resolves undefined", async () => {
    const socketPath = tmpSocketPath("reject");
    const srv = createIpcServer(socketPath, (method, _params, _respond) => {
      // A throwing handler produces the server's typed error frame (code 1000).
      throw new Error(`remote refused ${method}`);
    });
    servers.push(srv);
    const client = await connectIpcClient(socketPath, {});
    clients.push(client);

    // Pin: pre-fix this path was untested repo-wide (deleting the mapping
    // made remote failures resolve `undefined` with every suite green), and
    // the rejection class was IpcConnectionError — misfiling a healthy
    // connection's remote failure as a transport problem.
    const rejection = client.call("do-thing", {}, 2_000);
    await expect(rejection).rejects.toBeInstanceOf(IpcRemoteError);
    await expect(client.call("do-thing", {}, 2_000)).rejects.toThrow("remote refused do-thing");
    const error = await client.call("do-thing", {}, 2_000).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(IpcConnectionError);
    expect((error as IpcRemoteError).code).toBe(1000);
  });

  test("the SERVER side of the socket files remote failures the same way (#677 review)", async () => {
    const socketPath = tmpSocketPath("server-side");
    const srv = createIpcServer(socketPath, () => undefined);
    servers.push(srv);
    const client = await connectIpcClient(socketPath, {
      onRequest: () => {
        // A throwing client-side handler becomes the code-1000 error frame
        // the server.call path receives.
        throw new Error("client handler refused");
      },
    });
    clients.push(client);

    const error = await srv.call("do-thing", {}, 2_000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect(error).not.toBeInstanceOf(IpcConnectionError);
    expect(String((error as Error).message)).toContain("client handler refused");
  });
});
