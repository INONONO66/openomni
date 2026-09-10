import { describe, expect, test } from "bun:test";
import { Ipc } from "@openomni/protocol";
import { connectIpcClient, createIpcServer } from "../src/index";
import { deferred, within } from "./helpers/signal";
import { socketPath } from "./helpers/socket-path";
import { connectRaw, transportFixture } from "./helpers/transport";

describe("published callback contract", () => {
  const { servers, clients, rawSockets } = transportFixture();

  test("request and notification handlers receive only the original positional arguments", async () => {
    const serverNotification = deferred<number>();
    const clientNotification = deferred<number>();
    const server = await createIpcServer(socketPath("callback-arity"), (...args) => {
      const [method, , respond] = args;
      if (method === "notification.arity") serverNotification.resolve(args.length);
      respond(args.length);
    });
    servers.push(server);
    const client = await connectIpcClient(server.socketPath, {
      onRequest(...args) {
        args[2](args.length);
      },
      onNotification(...args) {
        clientNotification.resolve(args.length);
      },
    });
    clients.push(client);

    // Return the observed callback arities on the wire, rather than inspecting implementation types.
    const serverResult = await client.call("request.arity");
    const clientResult = await server.call("reverse.arity");
    expect(server.notify("notification.arity")).toBe(true);
    const raw = await connectRaw(server.socketPath);
    rawSockets.push(raw);
    raw.write(`${JSON.stringify(Ipc.createNotification("notification.arity"))}\n`);
    const notifications = await within(
      Promise.all([serverNotification.promise, clientNotification.promise]),
      "both notification callbacks",
    );

    expect({ serverResult, clientResult, notifications }).toEqual({
      serverResult: 5,
      clientResult: 3,
      notifications: [5, 2],
    });
  });
});
