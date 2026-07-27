import { afterEach, describe, expect, test } from "bun:test";
import { Ipc } from "@openomni/protocol";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { connectIpcClient } from "../../src/ipc/client";
import { IpcProtocolError } from "../../src/ipc/errors";
import { LineDecoder, encode } from "../../src/ipc/framing";

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
    `openomni-ipc-client-${label}-${process.pid}-${crypto.randomUUID()}.sock`,
  );
}

function listen(server: net.Server, pathname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pathname, resolve);
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

describe("IPC client method contracts", () => {
  const clients: Awaited<ReturnType<typeof connectIpcClient>>[] = [];
  const sockets: net.Socket[] = [];
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) server.close();
  });

  async function connectRawPeer(
    label: string,
  ): Promise<{ client: Awaited<ReturnType<typeof connectIpcClient>>; peer: net.Socket }> {
    const pathname = socketPath(label);
    let accept!: (socket: net.Socket) => void;
    const accepted = new Promise<net.Socket>((resolve) => {
      accept = resolve;
    });
    const server = net.createServer((socket) => accept(socket));
    servers.push(server);
    await listen(server, pathname);
    const client = await connectIpcClient(pathname);
    clients.push(client);
    const peer = await accepted;
    sockets.push(peer);
    return { client, peer };
  }

  test("rejects outgoing unknown and non-strict params without writing", async () => {
    const { client, peer } = await connectRawPeer("outgoing");
    let bytes = 0;
    peer.on("data", (chunk) => {
      bytes += chunk.length;
    });

    const unknown = await client.call("unknown.method", {}).catch((error) => error);
    expectFrozenProtocolError(unknown);
    const extra = await client
      .call("coordinator.bootstrap", { ...bootstrapParams, extra: true })
      .catch((error) => error);
    expectFrozenProtocolError(extra);
    const nested = await client
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
    await Bun.sleep(5);
    expect(bytes).toBe(0);
  });

  test("drops invalid incoming requests before onRequest and returns protocol errors", async () => {
    let handled = 0;
    const pathname = socketPath("incoming");
    let peer!: net.Socket;
    const server = net.createServer((socket) => {
      peer = socket;
      sockets.push(socket);
    });
    servers.push(server);
    await listen(server, pathname);
    const client = await connectIpcClient(pathname, {
      onRequest() {
        handled += 1;
      },
    });
    clients.push(client);

    const requests = [
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
    for (const request of requests) {
      const responsePromise = nextMessage(peer);
      peer.write(encode(request));
      const response = Ipc.Response.parse(await responsePromise);
      expect(response.error?.code).toBe(request.method === "unknown.method" ? 2000 : 3000);
    }
    peer.write(encode(Ipc.createNotification("unknown.method", {})));
    peer.write(
      encode(Ipc.createNotification("coordinator.bootstrap", { ...bootstrapParams, extra: true })),
    );
    await Bun.sleep(5);
    expect(handled).toBe(0);
  });

  test("bounds reflected validation failures and callback payloads", async () => {
    const canary = "ipc-secret-canary";
    const encodedCanary = Buffer.from(canary).toString("base64");
    let handled = 0;
    const pathname = socketPath("bounded-egress");
    let peer!: net.Socket;
    const server = net.createServer((socket) => {
      peer = socket;
      sockets.push(socket);
    });
    servers.push(server);
    await listen(server, pathname);
    const client = await connectIpcClient(pathname, {
      onRequest(_method, _params, respond) {
        handled += 1;
        respond({ ok: true, extra: { token: canary, encodedCanary } });
      },
    });
    clients.push(client);

    const invalidMethodResponse = nextMessage(peer);
    peer.write(encode(Ipc.createRequest(`${canary}.${encodedCanary}`, {})));
    expect(Ipc.Response.parse(await invalidMethodResponse).error).toEqual({
      code: 2000,
      message: "Unknown IPC method",
    });

    const invalidParamsResponse = nextMessage(peer);
    peer.write(
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

    const invalidResultResponse = nextMessage(peer);
    peer.write(encode(Ipc.createRequest("coordinator.bootstrap", bootstrapParams)));
    const response = Ipc.Response.parse(await invalidResultResponse);
    expect(response.error).toEqual({ code: 3000, message: "Invalid IPC result" });
    expect(JSON.stringify(response)).not.toContain(canary);
    expect(JSON.stringify(response)).not.toContain(encodedCanary);
    expect(handled).toBe(1);
  });

  test("rejects invalid and mismatched responses with frozen typed errors", async () => {
    const invalid = await connectRawPeer("invalid-result");
    const invalidRequestPromise = nextMessage(invalid.peer);
    const invalidCall = invalid.client.call("coordinator.bootstrap", bootstrapParams);
    const invalidRequest = Ipc.Request.parse(await invalidRequestPromise);
    invalid.peer.write(encode(Ipc.createResponse(invalidRequest.id, { ok: true, extra: true })));
    const invalidError = await invalidCall.catch((error) => error);
    expectFrozenProtocolError(invalidError);
    expect(invalidError.message).toContain("Invalid result");

    const mismatch = await connectRawPeer("mismatch");
    const mismatchRequestPromise = nextMessage(mismatch.peer);
    const mismatchCall = mismatch.client.call("coordinator.bootstrap", bootstrapParams);
    const mismatchRequest = Ipc.Request.parse(await mismatchRequestPromise);
    mismatch.peer.write(encode(Ipc.createResponse(`${mismatchRequest.id}-wrong`, { ok: true })));
    const mismatchError = await mismatchCall.catch((error) => error);
    expectFrozenProtocolError(mismatchError);
    expect(mismatchError.message).toContain("response mismatch");
  });

  test("validates callback results and performs a valid strict roundtrip", async () => {
    const pathname = socketPath("callback-result");
    let peer!: net.Socket;
    const server = net.createServer((socket) => {
      peer = socket;
      sockets.push(socket);
    });
    servers.push(server);
    await listen(server, pathname);
    const client = await connectIpcClient(pathname, {
      onRequest(_method, _params, respond) {
        respond({ ok: true, extra: true });
      },
    });
    clients.push(client);

    const invalidResponsePromise = nextMessage(peer);
    peer.write(encode(Ipc.createRequest("coordinator.bootstrap", bootstrapParams)));
    const invalidResponse = Ipc.Response.parse(await invalidResponsePromise);
    expect(invalidResponse.error?.code).toBe(3000);

    const valid = await connectRawPeer("valid");
    const validRequestPromise = nextMessage(valid.peer);
    const call = valid.client.call("coordinator.bootstrap", bootstrapParams);
    const request = Ipc.Request.parse(await validRequestPromise);
    valid.peer.write(encode(Ipc.createResponse(request.id, { ok: true })));
    await expect(call).resolves.toEqual({ ok: true });
  });
});
