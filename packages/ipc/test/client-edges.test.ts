import { afterEach, describe, expect, spyOn, test } from "bun:test";
import net from "node:net";
import { connectIpcClient } from "../src/client";
import { IpcConnectionError, IpcProtocolError } from "../src/errors";
import { deferred, within } from "./helpers/signal";
import { socketPath } from "./helpers/socket-path";

const rawServers: net.Server[] = [];
const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const server of rawServers.splice(0)) server.close();
});

function listenRaw(onConnection: (socket: net.Socket) => void): Promise<string> {
  const path = socketPath("client-edge");
  const server = net.createServer(onConnection);
  rawServers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(path));
  });
}

describe("IPC client transport edges", () => {
  test("a local connect error rejects as IpcConnectionError", async () => {
    await expect(connectIpcClient(socketPath("missing"))).rejects.toBeInstanceOf(
      IpcConnectionError,
    );
  });

  test("the configured connection deadline destroys a socket that never settles", async () => {
    const socket = new net.Socket();
    const createConnection = spyOn(net, "createConnection").mockReturnValue(socket);
    try {
      await expect(connectIpcClient("ignored", { connectTimeoutMs: 1 })).rejects.toBeInstanceOf(
        IpcConnectionError,
      );
      expect(socket.destroyed).toBe(true);
    } finally {
      createConnection.mockRestore();
    }
  });

  test("an error after connect marks the client disconnected", async () => {
    const socket = new net.Socket();
    const createConnection = spyOn(net, "createConnection").mockReturnValue(socket);
    try {
      const connecting = connectIpcClient("ignored");
      socket.emit("connect");
      const client = await connecting;
      clients.push(client);
      expect(client.connected).toBe(true);

      socket.emit("error", new Error("transport failed"));
      expect(client.connected).toBe(false);
    } finally {
      createConnection.mockRestore();
    }
  });

  test("a malformed server line fails a pending call as a protocol error", async () => {
    const requestReceived = deferred();
    const path = await listenRaw((socket) => {
      socket.once("data", () => {
        requestReceived.resolve();
        socket.write("not-json\n");
      });
    });
    const client = await connectIpcClient(path);
    clients.push(client);

    const call = client.call("edge", {}, 5_000);
    await within(requestReceived.promise, "raw server receiving request");
    await expect(call).rejects.toBeInstanceOf(IpcProtocolError);
    expect(client.connected).toBe(false);
  });

  test("an oversized server frame fails a pending call as a protocol error", async () => {
    const requestReceived = deferred();
    const path = await listenRaw((socket) => {
      socket.once("data", () => {
        requestReceived.resolve();
        socket.write("x".repeat(17 * 1024 * 1024));
      });
    });
    const client = await connectIpcClient(path);
    clients.push(client);

    const call = client.call("edge", {}, 12_000);
    await within(requestReceived.promise, "raw server receiving request");
    await expect(call).rejects.toBeInstanceOf(IpcProtocolError);
    expect(client.connected).toBe(false);
  }, 15_000);
});
