import { afterEach, describe, expect, test } from "bun:test";
import { Ipc } from "@openomni/protocol";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { connectIpcClient } from "../../src/ipc/client";
import { IpcProtocolError } from "../../src/ipc/errors";
import { LineDecoder, encode } from "../../src/ipc/framing";
import { createIpcServer } from "../../src/ipc/server";

const bootstrapParams = {
  authToken: "token",
  runtimeId: "runtime",
  workerId: "worker",
  generation: 0,
  configEpoch: "epoch",
};

function socketPath(label: string): string {
  return path.join(
    os.tmpdir(),
    `openomni-ipc-server-${label}-${process.pid}-${crypto.randomUUID()}.sock`,
  );
}

function rawConnection(pathname: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pathname, () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: net.Socket): Promise<unknown> {
  const decoder = new LineDecoder();
  return new Promise((resolve) => {
    socket.on("data", (chunk) => {
      const messages = decoder.push(chunk);
      if (messages.length > 0) resolve(messages[0]);
    });
  });
}

function expectFrozenProtocolError(error: unknown): asserts error is IpcProtocolError {
  expect(error).toBeInstanceOf(IpcProtocolError);
  expect(Object.isFrozen(error)).toBe(true);
}

describe("IPC server method contracts", () => {
  const servers: ReturnType<typeof createIpcServer>[] = [];
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];
  const sockets: net.Socket[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) server.close();
  });

  test("rejects unknown, extra, and nested-invalid params before the handler", async () => {
    let handled = 0;
    const server = createIpcServer(socketPath("params"), () => {
      handled += 1;
    });
    servers.push(server);
    const socket = await rawConnection(server.socketPath);
    sockets.push(socket);

    const cases = [
      Ipc.createRequest("unknown.method", {}),
      Ipc.createRequest("coordinator.bootstrap", { ...bootstrapParams, extra: true }),
      Ipc.createRequest("worker.kernel_query", {
        authToken: "token",
        workerId: "worker",
        generation: 0,
        sessionId: "session",
        runId: "run",
        request: { version: "kernel-query-v1", kind: "authenticated_attempt", identity: {} },
      }),
    ];

    for (const request of cases) {
      const responsePromise = nextMessage(socket);
      socket.write(encode(request));
      const response = Ipc.Response.parse(await responsePromise);
      expect(response.error?.code).toBe(request.method === "unknown.method" ? 2000 : 3000);
    }
    socket.write(encode(Ipc.createNotification("unknown.method", {})));
    socket.write(
      encode(Ipc.createNotification("coordinator.bootstrap", { ...bootstrapParams, extra: true })),
    );
    await Bun.sleep(5);
    expect(handled).toBe(0);
  });

  test("emits only bounded structural failures for untrusted input and thrown values", async () => {
    const canary = "ipc-secret-canary";
    const encodedCanary = Buffer.from(canary).toString("base64");
    const server = createIpcServer(socketPath("bounded-egress"), () => {
      throw new Error(`${canary}:${encodedCanary}`);
    });
    servers.push(server);
    const socket = await rawConnection(server.socketPath);
    sockets.push(socket);

    const malformedResponse = nextMessage(socket);
    socket.write(`{"${canary}":"${encodedCanary}"\n`);
    expect(Ipc.Response.parse(await malformedResponse).error).toEqual({
      code: 4001,
      message: "Invalid IPC frame",
    });

    const invalidParamsResponse = nextMessage(socket);
    socket.write(
      encode(
        Ipc.createRequest("coordinator.bootstrap", {
          ...bootstrapParams,
          [canary]: encodedCanary,
        }),
      ),
    );
    expect(Ipc.Response.parse(await invalidParamsResponse).error).toEqual({
      code: 3000,
      message: "Invalid IPC params",
    });

    const handlerFailureResponse = nextMessage(socket);
    socket.write(encode(Ipc.createRequest("coordinator.bootstrap", bootstrapParams)));
    const response = Ipc.Response.parse(await handlerFailureResponse);
    expect(response.error).toEqual({ code: 1000, message: "IPC handler failed" });
    expect(JSON.stringify(response)).not.toContain(canary);
    expect(JSON.stringify(response)).not.toContain(encodedCanary);
  });

  test("returns frozen typed errors for invalid outgoing calls", async () => {
    const server = createIpcServer(socketPath("outgoing"), () => undefined);
    servers.push(server);

    const unknown = await server.call("unknown.method", {}).catch((error) => error);
    expectFrozenProtocolError(unknown);
    const extra = await server
      .call("coordinator.bootstrap", { ...bootstrapParams, extra: true })
      .catch((error) => error);
    expectFrozenProtocolError(extra);
    const nested = await server
      .call("worker.kernel_query", {
        authToken: "token",
        workerId: "worker",
        generation: 0,
        sessionId: "session",
        runId: "run",
        request: { version: "kernel-query-v1", kind: "authenticated_attempt", identity: {} },
      })
      .catch((error) => error);
    expectFrozenProtocolError(nested);
  });

  test("returns a frozen typed error for an invalid handler result", async () => {
    const server = createIpcServer(socketPath("result"), (_method, _params, respond) => {
      respond({ ok: true, extra: true });
    });
    servers.push(server);
    const client = await connectIpcClient(server.socketPath);
    clients.push(client);

    const error = await client
      .call("coordinator.bootstrap", bootstrapParams)
      .catch((cause) => cause);
    expectFrozenProtocolError(error);
    expect(error.message).toContain("Invalid IPC result");
  });

  test("rejects a mismatched response id with a frozen typed error", async () => {
    let server!: ReturnType<typeof createIpcServer>;
    server = createIpcServer(
      socketPath("mismatch"),
      (method, _params, respond, _notify, connectionId) => {
        if (method !== "coordinator.bootstrap") return;
        server.useConnection(connectionId);
        respond({ ok: true });
      },
    );
    servers.push(server);
    const socket = await rawConnection(server.socketPath);
    sockets.push(socket);
    socket.write(encode(Ipc.createRequest("coordinator.bootstrap", bootstrapParams)));
    await nextMessage(socket);

    const requestPromise = nextMessage(socket);
    const call = server.call("coordinator.bootstrap", bootstrapParams);
    const request = Ipc.Request.parse(await requestPromise);
    socket.write(encode(Ipc.createResponse(`${request.id}-wrong`, { ok: true })));

    const error = await call.catch((cause) => cause);
    expectFrozenProtocolError(error);
    expect(error.message).toContain("response mismatch");
  });

  test("performs a valid strict roundtrip", async () => {
    const server = createIpcServer(socketPath("valid"), (_method, params, respond) => {
      expect(params).toEqual(bootstrapParams);
      respond({ ok: true });
    });
    servers.push(server);
    const client = await connectIpcClient(server.socketPath);
    clients.push(client);

    await expect(client.call("coordinator.bootstrap", bootstrapParams)).resolves.toEqual({
      ok: true,
    });
  });
});
