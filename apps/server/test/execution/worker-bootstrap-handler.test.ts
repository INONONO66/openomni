import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { WorkerBootstrapHandler } from "../../src/execution/worker-bootstrap-handler";

type BootstrapServer = Parameters<typeof WorkerBootstrapHandler.handleBootstrap>[0]["server"];

const ipcAuthToken = "supervisor-secret";
const bootstrapIdentity = {
  runtimeId: "runtime-1",
  workerId: "worker-1",
  generation: 3,
};

function proof(challenge: string, phase: "request" | "ready"): string {
  return createHmac("sha256", ipcAuthToken)
    .update("openomni.worker-bootstrap-proof.v1\0")
    .update(phase)
    .update("\0")
    .update(challenge)
    .update("\0")
    .update(bootstrapIdentity.runtimeId)
    .update("\0")
    .update(bootstrapIdentity.workerId)
    .update("\0")
    .update(String(bootstrapIdentity.generation))
    .digest("base64url");
}

function validParams(challenge = "challenge-1") {
  return {
    authToken: `${challenge}.${proof(challenge, "request")}`,
    ...bootstrapIdentity,
    configEpoch: "epoch-1",
  };
}

function fixture() {
  const usedConnections: string[] = [];
  const closedConnections: string[] = [];
  const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const responses: unknown[] = [];
  const server: BootstrapServer = {
    useConnection: (id) => usedConnections.push(id),
    notify: (method, params) => notifications.push({ method, params }),
    closeConnection: (id) => closedConnections.push(id),
  };
  return { server, usedConnections, closedConnections, notifications, responses };
}

async function flushClose(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("WorkerBootstrapHandler", () => {
  test("binds the authenticated connection and emits exactly one challenge-bound ready notification", async () => {
    const state = WorkerBootstrapHandler.createState();
    const f = fixture();

    WorkerBootstrapHandler.handleBootstrap({
      params: validParams(),
      ipcAuthToken,
      workerId: "worker-1",
      server: f.server,
      connectionId: "connection-authorized",
      respond: (response) => f.responses.push(response),
      state,
    });
    await state.ready;

    expect(f.usedConnections).toEqual(["connection-authorized"]);
    expect(f.closedConnections).toEqual([]);
    expect(f.responses).toEqual([{ ok: true }]);
    expect(state.getBootstrap()).toEqual(validParams());
    expect(f.notifications).toEqual([
      {
        method: "worker.bootstrap_ready",
        params: {
          authToken: proof("challenge-1", "ready"),
          ...bootstrapIdentity,
        },
      },
    ]);
  });

  test("refuses malformed bootstrap, rejects readiness, and closes its connection", async () => {
    const state = WorkerBootstrapHandler.createState();
    const f = fixture();

    WorkerBootstrapHandler.handleBootstrap({
      params: { ...validParams(), generation: "invalid" },
      ipcAuthToken,
      workerId: "worker-1",
      server: f.server,
      connectionId: "connection-malformed",
      respond: (response) => f.responses.push(response),
      state,
    });
    await state.ready.then(
      () => {
        throw new Error("malformed bootstrap unexpectedly became ready");
      },
      (error) => expect(error).toBeInstanceOf(Error),
    );
    await flushClose();

    expect(f.responses).toHaveLength(1);
    expect(f.responses[0]).toMatchObject({ ok: false });
    expect(f.usedConnections).toEqual([]);
    expect(f.notifications).toEqual([]);
    expect(f.closedConnections).toEqual(["connection-malformed"]);
    expect(state.getBootstrap()).toBeNull();
  });

  test("refuses a wrong worker proof without binding or notifying and closes the connection", async () => {
    const state = WorkerBootstrapHandler.createState();
    const f = fixture();

    WorkerBootstrapHandler.handleBootstrap({
      params: validParams(),
      ipcAuthToken,
      workerId: "different-worker",
      server: f.server,
      connectionId: "connection-wrong-worker",
      respond: (response) => f.responses.push(response),
      state,
    });
    await flushClose();

    expect(f.responses).toEqual([{ ok: false, error: "unauthorized coordinator bootstrap" }]);
    expect(f.usedConnections).toEqual([]);
    expect(f.notifications).toEqual([]);
    expect(f.closedConnections).toEqual(["connection-wrong-worker"]);
    expect(state.getBootstrap()).toBeNull();
  });

  test("refuses replay on a second connection and never emits a second ready notification", async () => {
    const state = WorkerBootstrapHandler.createState();
    const f = fixture();
    const invoke = (connectionId: string) =>
      WorkerBootstrapHandler.handleBootstrap({
        params: validParams(),
        ipcAuthToken,
        workerId: "worker-1",
        server: f.server,
        connectionId,
        respond: (response) => f.responses.push(response),
        state,
      });

    invoke("connection-original");
    await state.ready;
    invoke("connection-replay");
    await flushClose();

    expect(f.responses).toEqual([
      { ok: true },
      { ok: false, error: "unauthorized coordinator bootstrap" },
    ]);
    expect(f.usedConnections).toEqual(["connection-original"]);
    expect(f.notifications).toHaveLength(1);
    expect(f.closedConnections).toEqual(["connection-replay"]);
  });

  test("closes and rejects readiness when connection binding fails", async () => {
    const state = WorkerBootstrapHandler.createState();
    const f = fixture();
    f.server.useConnection = () => {
      throw new Error("connection closed");
    };

    WorkerBootstrapHandler.handleBootstrap({
      params: validParams(),
      ipcAuthToken,
      workerId: "worker-1",
      server: f.server,
      connectionId: "connection-closed",
      respond: (response) => f.responses.push(response),
      state,
    });
    await state.ready.then(
      () => {
        throw new Error("closed connection unexpectedly became ready");
      },
      (error) => expect(error).toMatchObject({ message: "connection closed" }),
    );
    await flushClose();

    expect(f.responses).toEqual([{ ok: false, error: "connection closed" }]);
    expect(f.notifications).toEqual([]);
    expect(f.closedConnections).toEqual(["connection-closed"]);
    expect(state.getBootstrap()).toBeNull();
  });
});
