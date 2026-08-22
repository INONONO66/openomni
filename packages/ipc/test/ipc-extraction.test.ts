import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectIpcClient } from "@openomni/ipc";

const WORKER_ENTRY = fileURLToPath(
  new URL("../../../apps/server/src/execution/worker-entry.ts", import.meta.url),
);

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
