import { describe, test, expect, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_SCRIPT = fileURLToPath(new URL("../../src/daemon/main.ts", import.meta.url));

const spawned: Subprocess[] = [];

afterAll(async () => {
  for (const proc of spawned) {
    proc.kill("SIGTERM");
  }
  await Promise.all(spawned.map((p) => p.exited));
  spawned.length = 0;
});

let portBase = 19100 + (process.pid % 100) * 10;
function nextEnv(): Record<string, string> {
  const healthPort = portBase;
  const wsPort = portBase + 1;
  portBase += 10;
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    OPENOMNI_HEALTH_PORT: String(healthPort),
    OPENOMNI_WS_PORT: String(wsPort),
    OPENOMNI_IPC_SOCKET: path.join(os.tmpdir(), `openomni-test-${ts}.sock`),
    OPENOMNI_PID_PATH: path.join(os.tmpdir(), `openomni-test-${ts}.pid`),
    OPENOMNI_DRAIN_TIMEOUT_MS: "500",
  };
}

function spawnDaemon(env: Record<string, string>): Subprocess {
  const proc = Bun.spawn(["bun", DAEMON_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  spawned.push(proc);
  return proc;
}

async function waitForHealth(port: number, timeoutMs = 6000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return res;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`health endpoint at :${port} not ready after ${timeoutMs}ms`);
}

describe("daemon lifecycle", () => {
  test("health endpoint returns 200 with status json", async () => {
    const env = nextEnv();
    spawnDaemon(env);

    const res = await waitForHealth(Number(env.OPENOMNI_HEALTH_PORT));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; pid: number; uptime: number };
    expect(body.status).toBe("ok");
    expect(typeof body.pid).toBe("number");
    expect(body.pid).toBeGreaterThan(0);
    expect(typeof body.uptime).toBe("number");
  });

  test("GET /health 404 on unknown path", async () => {
    const env = nextEnv();
    spawnDaemon(env);

    await waitForHealth(Number(env.OPENOMNI_HEALTH_PORT));

    const res = await fetch(`http://localhost:${env.OPENOMNI_HEALTH_PORT}/unknown`);
    expect(res.status).toBe(404);
  });

  test("PID file created on start and removed after shutdown", async () => {
    const env = nextEnv();
    const proc = spawnDaemon(env);

    await waitForHealth(Number(env.OPENOMNI_HEALTH_PORT));

    const pidPath = env.OPENOMNI_PID_PATH;
    expect(fs.existsSync(pidPath)).toBe(true);

    const recorded = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    expect(recorded).toBeGreaterThan(0);

    proc.kill("SIGTERM");
    await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("exit timeout")), 5000)),
    ]);

    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  test("SIGTERM triggers graceful shutdown with exit code 0", async () => {
    const env = nextEnv();
    const proc = spawnDaemon(env);

    await waitForHealth(Number(env.OPENOMNI_HEALTH_PORT));

    proc.kill("SIGTERM");

    const exitCode = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("process did not exit within 5s after SIGTERM")), 5000),
      ),
    ]);

    expect(exitCode).toBe(0);
  });

  test("SIGINT triggers graceful shutdown with exit code 0", async () => {
    const env = nextEnv();
    const proc = spawnDaemon(env);

    await waitForHealth(Number(env.OPENOMNI_HEALTH_PORT));

    proc.kill("SIGINT");

    const exitCode = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("process did not exit within 5s after SIGINT")), 5000),
      ),
    ]);

    expect(exitCode).toBe(0);
  });
});
