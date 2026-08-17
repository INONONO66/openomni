import fs from "node:fs";
import path from "node:path";
import { type BusEvent, Operational } from "@openomni/protocol";

/** Ownership marker (#audit M1): the manager that created the dir writes its pid here. */
const OWNER_PIDFILE = "owner.pid";

/**
 * A dir with no owner marker (crash before the marker was written, or a
 * pre-marker leftover) is cleaned by age alone — this also covers the
 * zero-socket dirs the old probe-based sweep never touched.
 */
const NO_MARKER_STALE_AGE_MS = 15 * 60_000;

export function createPrivateSocketDir(baseDir: string, events: BusEvent.Sink): string {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  cleanupStaleSocketDirs(baseDir, events);
  const dir = fs.mkdtempSync(path.join(baseDir, "openomni-workers-"));
  fs.chmodSync(dir, 0o700);
  // Staleness is "the owning manager process is dead", NOT "no socket answered
  // a connect probe" (#audit M1): a live manager whose only worker sits in
  // restart backoff has zero listening sockets but must not be swept.
  fs.writeFileSync(path.join(dir, OWNER_PIDFILE), String(process.pid));
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
      cleanupIfStale(dirPath);
    } catch (err) {
      warnCleanup(events, sweepTraceId, "stale worker directory cleanup failed", {
        dirPath,
        error: String(err),
      });
    }
  }
}

function cleanupIfStale(dirPath: string): void {
  const ownerPid = readOwnerPid(dirPath);
  if (ownerPid !== undefined) {
    if (isProcessAlive(ownerPid)) return;
    fs.rmSync(dirPath, { recursive: true, force: true });
    return;
  }

  const ageMs = Date.now() - fs.statSync(dirPath).mtimeMs;
  if (ageMs < NO_MARKER_STALE_AGE_MS) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function readOwnerPid(dirPath: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dirPath, OWNER_PIDFILE), "utf8");
  } catch {
    return undefined;
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Only a definitive ESRCH counts as dead. EPERM means the pid exists but
    // belongs to another user (alive); anything else is inconclusive and
    // cleanup is best-effort, so it fails toward keeping the dir.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
