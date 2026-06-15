import type { Subprocess } from "bun";

const DEFAULT_WORKER_STOP_GRACE_MS = 5_000;
const MAX_RESTARTS_PER_WINDOW = 10;
const MAX_BACKOFF_MS = 30_000;
const MAX_DISPATCH_TIMEOUT_MS = 600_000;

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
  "OPENOMNI_WORKER_ENV_FIXTURE",
  "OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS",
]);

export function buildWorkerEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of workerEnvKeys) {
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

export function resolveDispatchTimeoutMs(params: Record<string, unknown>): number {
  const budget = (params as { budget?: { maxWallTimeMs?: number } }).budget;
  return Math.min(
    Math.max(budget?.maxWallTimeMs ?? 300_000, 300_000) + 30_000,
    MAX_DISPATCH_TIMEOUT_MS,
  );
}

export async function waitForSupervisorReady(
  workerId: number,
  isReady: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
