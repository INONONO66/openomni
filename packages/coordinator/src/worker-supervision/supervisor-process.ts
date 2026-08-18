import { Ipc } from "@openomni/protocol";
import { WorkerDeliveryError } from "../error";
import type { Subprocess } from "bun";

const DEFAULT_WORKER_STOP_GRACE_MS = 5_000;
const DEFAULT_WORKER_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_DISPATCH_TIMEOUT_MS = 600_000;

/**
 * Crash-loop breaker (#audit M2): a generation that dies (or never becomes
 * ready) within this many ms of its spawn counts as a fast crash; this many
 * consecutive fast crashes trip the breaker and restarts stop.
 */
export const FAST_CRASH_THRESHOLD_MS = 5_000;
export const MAX_CONSECUTIVE_FAST_CRASHES = 5;

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

function nonNegativeEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function workerStopGraceMs(): number {
  return nonNegativeEnvMs("OPENOMNI_WORKER_STOP_GRACE_MS", DEFAULT_WORKER_STOP_GRACE_MS);
}

export function workerConnectTimeoutMs(): number {
  return nonNegativeEnvMs("OPENOMNI_WORKER_CONNECT_TIMEOUT_MS", DEFAULT_WORKER_CONNECT_TIMEOUT_MS);
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

/**
 * Exponential restart backoff from the consecutive fast-crash count. The old
 * MAX_RESTARTS_PER_WINDOW plateau is gone with the 60s window it belonged to
 * (#audit M2): the breaker now trips at MAX_CONSECUTIVE_FAST_CRASHES, so
 * counts never grow past it.
 */
export function resolveRestartDelay(restartCount: number): number {
  const base = nonNegativeEnvMs(
    "OPENOMNI_WORKER_RESTART_BASE_DELAY_MS",
    DEFAULT_RESTART_BASE_DELAY_MS,
  );
  return Math.min(base * 2 ** (Math.max(restartCount, 1) - 1), MAX_BACKOFF_MS);
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
      throw new WorkerDeliveryError({
        message: `worker ${workerId} stopped while waiting for readiness`,
        code: "worker_stopped",
      });
    }
    if (isReady()) return;
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new WorkerDeliveryError({
    message: `worker ${workerId} not ready after ${timeoutMs}ms`,
    code: "worker_not_ready",
  });
}

// #500 B3: both result guards validate against the Methods table instead of
// duck-typed property peeks — a drifted frame reads as refusal, never success.
export function isBootstrapAccepted(value: unknown): boolean {
  const parsed = Ipc.Methods["coordinator.bootstrap"].result.safeParse(value);
  return parsed.success && parsed.data.ok;
}

export function isShutdownAcknowledged(value: unknown): boolean {
  const parsed = Ipc.Methods["worker.shutdown_idle"].result.safeParse(value);
  return parsed.success && parsed.data.acknowledged;
}
