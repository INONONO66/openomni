/**
 * #496 extraction contract for `@openomni/ipc`.
 *
 * Proves the moved transport keeps its meaning behind the new package
 * boundary: framing round trips, malformed-frame and timeout/protocol
 * errors, bidirectional (reverse-direction) calls, worker-side
 * authentication rejection without secret leakage, and startup of the REAL
 * `apps/server/src/execution/worker-entry.ts` over `@openomni/ipc` alone —
 * the worker side imports no coordinator transport.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectIpcClient,
  createIpcServer,
  IpcConnectionError,
  IpcProtocolError,
  IpcTimeoutError,
} from "@openomni/ipc";
import { encode, LineDecoder } from "../src/framing";

const WORKER_ENTRY = fileURLToPath(
  new URL("../../../apps/server/src/execution/worker-entry.ts", import.meta.url),
);

function tmpSocketPath(label: string): string {
  return path.join(os.tmpdir(), `omo-ipc-extraction-${label}-${process.pid}.sock`);
}

/** Raw NDJSON exchange over the unix socket — no client-side schema help. */
function rawExchange(socketPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const decoder = new LineDecoder();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("no response to raw frame"));
    }, 5000);
    socket.on("connect", () => socket.write(line));
    socket.on("data", (chunk) => {
      const messages = decoder.push(chunk);
      if (messages.length > 0) {
        clearTimeout(timer);
        socket.destroy();
        resolve(messages[0]);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("framing round trips", () => {
  test("encode → LineDecoder round-trips a request frame split across chunks", () => {
    const decoder = new LineDecoder();
    const message = {
      type: "request",
      id: "req-1",
      method: "coordinator.spawn_run",
      params: { runId: "run-1", prompt: "hello 😀" },
    };
    const bytes = encode(message);
    expect(decoder.push(bytes.slice(0, 7))).toEqual([]);
    expect(decoder.push(bytes.slice(7))).toEqual([message]);
  });

  test("oversized frame rejects with IpcProtocolError and the decoder recovers", () => {
    const decoder = new LineDecoder();
    expect(() => decoder.push("x".repeat(16 * 1024 * 1024 + 1))).toThrow(IpcProtocolError);
    expect(decoder.push('{"recovered":true}\n')).toEqual([{ recovered: true }]);
  });
});

describe("timeout and protocol errors over a real socket", () => {
  test("unanswered call rejects with IpcTimeoutError", async () => {
    const socketPath = tmpSocketPath("timeout");
    const server = createIpcServer(socketPath, () => {
      // never respond
    });
    try {
      const client = await connectIpcClient(socketPath);
      expect(client.call("coordinator.bootstrap", {}, 50)).rejects.toBeInstanceOf(IpcTimeoutError);
      client.close();
    } finally {
      server.close();
    }
  });

  test("server.call without a connected client rejects with IpcConnectionError", async () => {
    const socketPath = tmpSocketPath("noclient");
    const server = createIpcServer(socketPath, () => undefined);
    try {
      expect(server.call("worker.deliver_message", {})).rejects.toBeInstanceOf(IpcConnectionError);
    } finally {
      server.close();
    }
  });

  test("non-JSON frame gets a 4001 error response and the connection survives", async () => {
    const socketPath = tmpSocketPath("malformed");
    const server = createIpcServer(socketPath, (_m, _p, respond) => respond({ ok: true }));
    try {
      const response = (await rawExchange(socketPath, "this is not json\n")) as {
        type: string;
        error?: { code: number };
      };
      expect(response.type).toBe("response");
      expect(response.error?.code).toBe(4001);
    } finally {
      server.close();
    }
  });

  test("valid JSON with an unknown message shape gets a 4000 protocol error", async () => {
    const socketPath = tmpSocketPath("unknown-shape");
    const server = createIpcServer(socketPath, (_m, _p, respond) => respond({ ok: true }));
    try {
      const response = (await rawExchange(socketPath, '{"neither":"request-nor-response"}\n')) as {
        type: string;
        error?: { code: number };
      };
      expect(response.type).toBe("response");
      expect(response.error?.code).toBe(4000);
    } finally {
      server.close();
    }
  });
});

describe("bidirectional transport (server → client reverse direction)", () => {
  test("reverse request over one socket — the owner-device pattern", async () => {
    const socketPath = tmpSocketPath("reverse");
    const server = createIpcServer(socketPath, () => undefined);
    try {
      const client = await connectIpcClient(socketPath, {
        onRequest(method, params, respond) {
          respond({ echoed: method, got: params?.value });
        },
      });
      const result = await server.call("owner.device_ping", { value: 42 });
      expect(result).toEqual({ echoed: "owner.device_ping", got: 42 });
      client.close();
    } finally {
      server.close();
    }
  });
});

describe("worker-entry startup over @openomni/ipc", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-ipc-extraction-worker-"));
  const socketPath = path.join(tmpDir, "worker.sock");
  const authToken = `ipc-extraction-secret-${crypto.randomUUID()}`;
  let worker: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    worker = Bun.spawn(
      ["bun", WORKER_ENTRY, "--", "--worker-id", "ipc-extraction", "--socket", socketPath],
      {
        env: {
          ...process.env,
          OPENOMNI_WORKER_IPC_TOKEN: authToken,
          OPENOMNI_DB_PATH: path.join(tmpDir, "worker.db"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(socketPath)) {
      if (Date.now() > deadline) throw new Error("worker-entry socket never appeared");
      await Bun.sleep(100);
    }
  });

  afterAll(async () => {
    worker.kill();
    await worker.exited;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("bootstrap with a wrong token is rejected without leaking the real token", async () => {
    const client = await connectIpcClient(socketPath);
    const result = await client.call("coordinator.bootstrap", {
      authToken: "wrong-token",
      bootstrap: { configEpoch: "", agents: [], toolCatalog: [], credentials: {} },
    });
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(JSON.stringify(result)).not.toContain(authToken);
    client.close();
  });

  test("spawn_run with a wrong token gets a typed authentication denial", async () => {
    const client = await connectIpcClient(socketPath);
    const result = (await client.call("coordinator.spawn_run", {
      authToken: "wrong-token",
      runId: "run-denied",
      sessionId: "ses-denied",
    })) as { status: string; error?: string };
    expect(result.status).toBe("failed");
    expect(result.error).toBe("unauthorized coordinator request");
    expect(JSON.stringify(result)).not.toContain(authToken);
    client.close();
  });

  test("bootstrap with the real token succeeds and announces bootstrap_ready", async () => {
    let readyWorkerId: unknown;
    const ready = new Promise<void>((resolve) => {
      connectIpcClient(socketPath, {
        onNotification(method, params) {
          if (method === "worker.bootstrap_ready") {
            readyWorkerId = params?.workerId;
            resolve();
          }
        },
      }).then(async (client) => {
        const result = await client.call("coordinator.bootstrap", {
          authToken,
          bootstrap: { configEpoch: "", agents: [], toolCatalog: [], credentials: {} },
        });
        expect(result).toEqual({ ok: true });
      });
    });
    await ready;
    expect(readyWorkerId).toBe("ipc-extraction");
  });
});
