import { createHmac, timingSafeEqual } from "node:crypto";
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
  "OPENOMNI_WORKER_ENV_FIXTURE",
  "OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS",
  "OPENOMNI_WORKER_FIRST_READY_DELAY_MS",
  "OPENOMNI_WORKER_BOOTSTRAP_REJECTS",
]);

export function buildWorkerEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of workerEnvKeys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export const WORKER_GENERATION_KEY_BYTES = 32;

export function createWorkerGenerationKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(WORKER_GENERATION_KEY_BYTES));
}

export interface WorkerGenerationKeySignerContext {
  readonly runtimeId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly principalId: string;
  readonly attempt: Readonly<{
    version: "attempt-ref-v1";
    workItemId: string;
    attemptId: string;
    attemptSeq: number;
  }>;
  readonly processId: number;
}

export interface WorkerGenerationKeySigner {
  readonly context: WorkerGenerationKeySignerContext;
  sign(bytes: Uint8Array): Uint8Array;
  dispose(): void;
}

export function createWorkerGenerationKeySigner(
  key: Uint8Array,
  context: WorkerGenerationKeySignerContext,
): WorkerGenerationKeySigner {
  if (key.byteLength !== WORKER_GENERATION_KEY_BYTES) {
    throw new TypeError("invalid worker generation key");
  }
  let available = true;
  return Object.freeze({
    context: Object.freeze(context),
    sign(bytes: Uint8Array): Uint8Array {
      if (!available) throw new Error("worker generation key unavailable");
      available = false;
      try {
        return new Uint8Array(createHmac("sha256", key).update(bytes).digest());
      } finally {
        key.fill(0);
      }
    },
    dispose(): void {
      available = false;
      key.fill(0);
    },
  });
}

export function workerGenerationToken(key: Uint8Array): string {
  if (key.byteLength !== WORKER_GENERATION_KEY_BYTES) {
    throw new TypeError("invalid worker generation key");
  }
  return createHmac("sha256", key)
    .update("openomni.worker-generation-token.v1")
    .digest("base64url");
}

export type WorkerBootstrapProofContext = Readonly<{
  runtimeId?: string;
  workerId: string;
  generation: number;
}>;

export function createWorkerBootstrapChallenge(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export function workerBootstrapProof(
  authToken: string,
  challenge: string,
  phase: "request" | "ready",
  context: WorkerBootstrapProofContext,
): string {
  return createHmac("sha256", authToken)
    .update("openomni.worker-bootstrap-proof.v1\0")
    .update(phase)
    .update("\0")
    .update(challenge)
    .update("\0")
    .update(context.runtimeId ?? "")
    .update("\0")
    .update(context.workerId)
    .update("\0")
    .update(String(context.generation))
    .digest("base64url");
}

export function isWorkerBootstrapProof(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function writeWorkerGenerationKey(
  proc: Subprocess<"pipe", "pipe", "pipe">,
  key: Uint8Array,
): void {
  try {
    const written = proc.stdin.write(key);
    if (written !== key.byteLength) throw new Error("incomplete worker generation key write");
  } finally {
    key.fill(0);
  }
}

export function writeWorkerPrivateFrame(
  proc: Subprocess<"pipe", "pipe", "pipe">,
  frame: Uint8Array,
): void {
  try {
    if (frame.byteLength > 0xffff_ffff) throw new RangeError("worker private frame is too large");
    const lengthPrefix = new Uint8Array(4);
    new DataView(lengthPrefix.buffer).setUint32(0, frame.byteLength, false);
    if (proc.stdin.write(lengthPrefix) !== lengthPrefix.byteLength) {
      throw new Error("incomplete worker private frame length write");
    }
    if (proc.stdin.write(frame) !== frame.byteLength) {
      throw new Error("incomplete worker private frame write");
    }
    proc.stdin.flush();
  } finally {
    frame.fill(0);
  }
}

export function closeWorkerPrivatePipe(proc: Subprocess<"pipe", "pipe", "pipe">): void {
  try {
    void proc.stdin.end();
  } catch {
    // The process exit path may race an explicit stop that already closed it.
  }
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
