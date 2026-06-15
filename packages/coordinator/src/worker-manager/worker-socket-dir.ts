import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";

const SOCKET_PROBE_TIMEOUT_MS = 1000;

export function createPrivateSocketDir(baseDir: string): string {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  cleanupStaleSocketDirs(baseDir);
  const dir = fs.mkdtempSync(path.join(baseDir, "openomni-workers-"));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function cleanupStaleSocketDirs(baseDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch (err) {
    warnCleanup("failed to read socket base directory", {
      baseDir,
      error: String(err),
    });
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith("openomni-workers-")) continue;
    const dirPath = path.join(baseDir, entry);
    try {
      if (!fs.lstatSync(dirPath).isDirectory()) continue;
    } catch (err) {
      warnCleanup("failed to stat worker directory during cleanup", {
        dirPath,
        error: String(err),
      });
      continue;
    }

    void cleanupIfStale(dirPath);
  }
}

async function cleanupIfStale(dirPath: string): Promise<void> {
  try {
    await cleanupIfStaleUnsafe(dirPath);
  } catch (err) {
    warnCleanup("stale worker directory cleanup failed", {
      dirPath,
      error: String(err),
    });
  }
}

async function cleanupIfStaleUnsafe(dirPath: string): Promise<void> {
  const files = fs.readdirSync(dirPath);
  const sockets = files.filter((f) => f.endsWith(".sock"));

  if (sockets.length === 0) return;

  const results = await Promise.all(sockets.map((sock) => isSocketAlive(path.join(dirPath, sock))));
  if (results.some(Boolean)) return;

  fs.rmSync(dirPath, { recursive: true, force: true });
}

function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath);
    conn.setTimeout(SOCKET_PROBE_TIMEOUT_MS);
    conn.once("connect", () => {
      conn.destroy();
      resolve(true);
    });
    conn.once("error", () => {
      conn.destroy();
      resolve(false);
    });
    conn.once("timeout", () => {
      conn.destroy();
      resolve(false);
    });
  });
}

function warnCleanup(msg: string, context: Record<string, unknown>): void {
  Bus.publish(Operational.Warn, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "coordinator.worker-manager",
    msg,
    context,
  });
}
