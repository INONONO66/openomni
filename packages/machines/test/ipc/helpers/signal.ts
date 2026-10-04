import { spawnSync } from "node:child_process";
import { z } from "zod";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

export function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // A deadline only fails the test; completion always comes from the subscribed signal.
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    promise.finally(() => clearTimeout(timer)).then(resolve, reject);
  });
}

/** Subscribe before triggering failure; assertions run after the action, not inside Bun's matcher. */
export function captureError<T>(promise: Promise<T>): Promise<Error> {
  return promise.then(
    () => { throw new Error("expected promise to reject"); },
    z.instanceof(Error).parse,
  );
}

class ProcessStillPresentError extends Error {
  constructor(pid: number, state: string) {
    super(`process ${pid} still present (state ${state}) after the descendant-exit guard elapsed`);
    this.name = "ProcessStillPresentError";
  }
}

/** ESRCH is the only completion signal; EPERM or success means the pid is still in the process table. */
const reaped = (pid: number): boolean => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return z.object({ code: z.literal("ESRCH") }).safeParse(error).success; }
};

/**
 * Bounded observation poll across the process-table boundary — the one
 * sanctioned wait pattern. A SIGKILLed grandchild reparented to init stays a
 * zombie until init reaps it, and `kill(pid, 0)` succeeds on a zombie, so the
 * child's `close` event cannot stand in for descendant exit and there is no
 * event to subscribe to. Completion is `ESRCH` for every pid; the timeout is a
 * failure guard, never a synchronizer.
 */
export async function awaitGone(pids: readonly number[], timeoutMs = 5_000): Promise<void> {
  let present = [...pids];
  let guarded = true;
  const observed = (async () => {
    while (guarded) {
      present = present.filter((pid) => !reaped(pid));
      if (present.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  try {
    await within(observed, "every descendant to leave the process table", timeoutMs);
  } catch {
    const pid = present[0] ?? pids[0] ?? -1;
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)]).stdout?.toString().trim();
    throw new ProcessStillPresentError(pid, state || "not in ps output");
  } finally {
    guarded = false;
  }
}
