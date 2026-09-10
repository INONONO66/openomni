import { describe, expect, test } from "bun:test";
import { connectIpcClient, createIpcServer } from "../src/index";
import { deferred, within } from "./helpers/signal";
import { socketPath } from "./helpers/socket-path";
import { connectRaw, transportFixture } from "./helpers/transport";

describe("disconnect observers", () => {
  const { servers, clients, rawSockets } = transportFixture();

  async function observedServer() {
    const disconnects: string[] = [];
    let next = deferred<string>();
    const server = await createIpcServer(
      socketPath("disconnect"),
      (_method, _params, respond) => respond({ ok: true }),
      { onDisconnect: (id) => { disconnects.push(id); next.resolve(id); } },
    );
    servers.push(server);
    return {
      server,
      disconnects,
      async disconnect(action: () => void) {
        next = deferred<string>();
        action();
        return await within(next.promise, "server disconnect observer");
      },
    };
  }

  test("onDisconnect fires once for each gracefully closed connection", async () => {
    const observed = await observedServer();
    const first = await connectIpcClient(observed.server.socketPath);
    const second = await connectIpcClient(observed.server.socketPath);
    clients.push(first, second);
    await first.call("ping");
    await second.call("ping");

    const firstId = await observed.disconnect(() => first.close());
    expect(observed.disconnects).toEqual([firstId]);
    const secondId = await observed.disconnect(() => second.close());
    expect(observed.disconnects).toEqual([firstId, secondId]);
    expect(firstId).not.toBe(secondId);
  });

  test("onDisconnect fires once on abrupt socket destruction", async () => {
    const observed = await observedServer();
    const raw = await connectRaw(observed.server.socketPath);
    rawSockets.push(raw);
    const id = await observed.disconnect(() => raw.destroy());
    expect(observed.disconnects).toEqual([id]);
    await expect(observed.server.call("after.disconnect")).rejects.toThrow("no connected client");
  });
});
