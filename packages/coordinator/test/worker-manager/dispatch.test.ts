import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerManager } from "../../src/index";
import { collectorPorts } from "../harness/ports";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));

describe("worker manager dispatch", () => {
  test("workers inherit only explicitly allowed runtime environment updates", async () => {
    const previous = {
      discord: process.env.DISCORD_BOT_TOKEN,
      authFile: process.env.OPENOMNI_AUTH_FILE,
      home: process.env.HOME,
    };
    process.env.OPENOMNI_WORKER_ENV_FIXTURE = "runtime-value";
    process.env.OPENOMNI_AUTH_FILE = "/tmp/openomni-secret-auth.json";
    process.env.HOME = "/tmp/openomni-secret-home";
    process.env.DISCORD_BOT_TOKEN = "secret-token";
    const socketDir = `/tmp/omo-dispatch-env-${process.pid}`;
    fs.mkdirSync(socketDir, { recursive: true });
    const manager = createWorkerManager(
      {
        maxActiveWorkers: 1,
        workerScript: WORKER_ENTRY,
        socketDir,
        extraWorkerEnvKeys: ["OPENOMNI_WORKER_ENV_FIXTURE"],
      },
      collectorPorts(),
    );
    try {
      for (const [runId, envName, expected] of [
        ["run-env", "OPENOMNI_WORKER_ENV_FIXTURE", "runtime-value"],
        ["run-secret", "DISCORD_BOT_TOKEN", undefined],
        ["run-auth-token", "OPENOMNI_WORKER_IPC_TOKEN", undefined],
        ["run-auth-file", "OPENOMNI_AUTH_FILE", undefined],
        ["run-home", "HOME", undefined],
      ] as const) {
        const result = await manager.deliver(runId, {
          traceId: "trace-coordinator-test",
          sessionId: "session-env",
          prompt: "test",
          envName,
        });
        expect((result as Record<string, unknown>).envValue).toBe(expected);
      }
    } finally {
      await manager.shutdown();
      delete process.env.OPENOMNI_WORKER_ENV_FIXTURE;
      for (const [key, value] of [
        ["OPENOMNI_AUTH_FILE", previous.authFile],
        ["DISCORD_BOT_TOKEN", previous.discord],
        ["HOME", previous.home],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
