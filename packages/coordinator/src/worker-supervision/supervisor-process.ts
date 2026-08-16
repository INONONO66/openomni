import type { Subprocess } from "bun";

const DEFAULT_WORKER_STOP_GRACE_MS = 5_000;
const MAX_RESTARTS_PER_WINDOW = 10;
const MAX_BACKOFF_MS = 30_000;
const MAX_DISPATCH_TIMEOUT_MS = 600_000;

// Production allowlist only. Test fixtures that need extra keys (e.g.
// OPENOMNI_WORKER_ENV_FIXTURE, OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS) pass them
// explicitly through `extraEnvKeys` — they must never ride the default that
// every production worker inherits.
const workerEnvKeys = new Set([
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "BUN_INSTALL",
  "NODE_ENV",
  "CI",
  "OPENOMNI_DB_PATH",
  "OPENOMNI_MODELS_URL",
  "OPENOMNI_MODELS_PATH",
  "OPENOMNI_DISABLE_MODELS_FETCH",
]);

export function buildWorkerEnv(
  source: NodeJS.ProcessEnv,
  extraKeys: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...workerEnvKeys, ...extraKeys]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function workerStopGraceMs(): number {
  const raw = process.env.OPENOMNI_WORKER_STOP_GRACE_MS;
  if (!raw) return DEFAULT_WORKER_STOP_GRACE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WORKER_STOP_GRACE_MS;
}

export async function waitForWorkerExit(
  proc: Pick<Subprocess, "exited">,
  timeoutMs: number,
): Promise<"exited" | "timeout"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited.then(() => "exited" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function resolveRestartDelay(restartCount: number): number {
  return restartCount > MAX_RESTARTS_PER_WINDOW
    ? MAX_BACKOFF_MS
    : Math.min(1000 * 2 ** (restartCount - 1), MAX_BACKOFF_MS);
}

/**
 * The driver-level wall-time ceiling for one delivery (#462 §4): the task's
 * budget wall time plus a margin for transport/bootstrap overhead. The agent
 * loop inside the worker enforces the budget itself; this ceiling is the
 * physics backstop that kills the process when the loop is the thing that
 * hung. No floor — a task that declares a small budget gets a small ceiling.
 * A finite positive budget is honored even above MAX_DISPATCH_TIMEOUT_MS so
 * the driver never kills a run the loop's own budget still allows. Unlimited
 * (`-1` per AgentBudget, or Infinity), absent, or invalid budgets get the
 * MAX_DISPATCH_TIMEOUT_MS backstop — unlimited means the loop won't stop the
 * run, which is exactly when the physics backstop must exist.
 */
export function resolveDeliverTimeoutMs(params: Record<string, unknown>): number {
  const budget = (params as { budget?: { maxWallTimeMs?: number } }).budget;
  const wallTime = budget?.maxWallTimeMs;
  if (typeof wallTime === "number" && Number.isFinite(wallTime) && wallTime > 0) {
    return wallTime + deliverMarginMs();
  }
  return MAX_DISPATCH_TIMEOUT_MS;
}

const DEFAULT_DELIVER_MARGIN_MS = 30_000;

function deliverMarginMs(): number {
  const raw = process.env.OPENOMNI_DELIVER_MARGIN_MS;
  if (!raw) return DEFAULT_DELIVER_MARGIN_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELIVER_MARGIN_MS;
}

export async function waitForSupervisorReady(
  workerId: number,
  isReady: () => boolean,
  timeoutMs: number,
  isAborted?: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAborted?.() === true) {
      // A stopping supervisor can never become ready — fail the waiting
      // delivery immediately instead of polling out the full timeout.
      throw new Error(`worker ${workerId} stopped while waiting for readiness`);
    }
    if (isReady()) return;
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`worker ${workerId} not ready after ${timeoutMs}ms`);
}

export function isBootstrapAccepted(value: unknown): boolean {
  return value !== null && typeof value === "object" && (value as { ok?: unknown }).ok === true;
}

export function isShutdownAcknowledged(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { acknowledged?: unknown }).acknowledged === true
  );
}
