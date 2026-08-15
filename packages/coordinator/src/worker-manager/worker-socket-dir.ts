import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { type BusEvent, Operational } from "@openomni/protocol";

const SOCKET_PROBE_TIMEOUT_MS = 1000;

export function createPrivateSocketDir(baseDir: string, events: BusEvent.Sink): string {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  cleanupStaleSocketDirs(baseDir, events);
  const dir = fs.mkdtempSync(path.join(baseDir, "openomni-workers-"));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function cleanupStaleSocketDirs(baseDir: string, events: BusEvent.Sink): void {
  // One sweep, one trace: this cleanup warns up to three times per boot, and
  // three unrelated ids for one causal pass is the D11 defect. The id stays a
  // uuid until the Owner widens coordinator's ring-2 dep set to telemetry —
  // minting W3C locally would fork the vocabulary, which is worse.
  const sweepTraceId = crypto.randomUUID();
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch (err) {
    warnCleanup(events, sweepTraceId, "failed to read socket base directory", {
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
      warnCleanup(events, sweepTraceId, "failed to stat worker directory during cleanup", {
        dirPath,
        error: String(err),
      });
      continue;
    }

    void cleanupIfStale(dirPath, events, sweepTraceId);
  }
}

async function cleanupIfStale(
  dirPath: string,
  events: BusEvent.Sink,
  sweepTraceId: string,
): Promise<void> {
  try {
    await cleanupIfStaleUnsafe(dirPath);
  } catch (err) {
    warnCleanup(events, sweepTraceId, "stale worker directory cleanup failed", {
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

function warnCleanup(
  events: BusEvent.Sink,
  traceId: string,
  msg: string,
  context: Record<string, unknown>,
): void {
  events.publish(Operational.Warn, {
    traceId,
    time: Date.now(),
    component: "coordinator.worker-manager",
    msg,
    context,
  });
}
