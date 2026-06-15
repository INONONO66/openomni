import { createAbortError, throwIfAborted } from "./workspace-lock-abort.js";
import { acquireExternal, releaseExternal } from "./workspace-lock-files.js";
import type { LocalWorkspaceLock, WorkspaceLockWaiter } from "./workspace-lock-types.js";
import {
  clearWorkspaceUnsafe,
  markWorkspaceUnsafe,
  readUnsafeMeta,
  unsafeWorkspaceError,
} from "./workspace-lock-unsafe.js";

const active = new Map<string, LocalWorkspaceLock>();
const queue = new Map<string, WorkspaceLockWaiter[]>();

function wakeNextWaiter(workspace: string): void {
  const unsafeState = readUnsafeMeta(workspace);
  if (unsafeState) {
    rejectWaiters(workspace, unsafeWorkspaceError(workspace, unsafeState));
    return;
  }

  const waiters = queue.get(workspace);
  if (!waiters || waiters.length === 0) {
    queue.delete(workspace);
    return;
  }

  const next = waiters.shift();
  if (waiters.length === 0) queue.delete(workspace);
  if (!next) return;

  active.set(workspace, { runId: next.runId, depth: 0, pending: true });
  next.resolve();
}

function rejectWaiters(workspace: string, error: Error): void {
  const waiters = queue.get(workspace);
  if (!waiters) return;
  queue.delete(workspace);
  for (const waiter of waiters) waiter.reject(error);
}

export namespace WorkspaceLock {
  export async function acquire(
    workspace: string,
    runId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const unsafeState = readUnsafeMeta(workspace);
    if (unsafeState) throw unsafeWorkspaceError(workspace, unsafeState);

    const local = active.get(workspace);
    if (local && !local.pending && local.runId === runId) {
      local.depth++;
      return;
    }

    if (!local && (queue.get(workspace)?.length ?? 0) === 0) {
      await acquireExternal(workspace, runId, timeoutMs, signal);
      if (signal?.aborted) {
        releaseExternal(workspace, runId);
        throw createAbortError();
      }
      active.set(workspace, { runId, depth: 1, pending: false });
      return;
    }

    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      const entry: WorkspaceLockWaiter = {
        runId,
        resolve: () => resolve(),
        reject,
      };

      const timer = setTimeout(() => {
        const waiters = queue.get(workspace);
        if (waiters) {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) queue.delete(workspace);
        }
        reject(new Error(`workspace lock timeout after ${timeoutMs}ms for "${workspace}"`));
      }, timeoutMs);
      const onAbort = () => {
        const waiters = queue.get(workspace);
        if (waiters) {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) queue.delete(workspace);
        }
        reject(createAbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const complete = entry.resolve;
      entry.resolve = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        complete();
      };
      const fail = entry.reject;
      entry.reject = (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fail(error);
      };

      const waiters = queue.get(workspace) ?? [];
      waiters.push(entry);
      queue.set(workspace, waiters);
    });

    const remaining = Math.max(0, timeoutMs - (Date.now() - start));
    try {
      const unsafeState = readUnsafeMeta(workspace);
      if (unsafeState) throw unsafeWorkspaceError(workspace, unsafeState);
      await acquireExternal(workspace, runId, remaining, signal);
      if (signal?.aborted) {
        releaseExternal(workspace, runId);
        throw createAbortError();
      }
      active.set(workspace, { runId, depth: 1, pending: false });
    } catch (error) {
      const current = active.get(workspace);
      if (current?.runId === runId && current.pending) {
        active.delete(workspace);
        wakeNextWaiter(workspace);
      }
      throw error;
    }
  }

  export function release(workspace: string, runId: string): void {
    const local = active.get(workspace);
    if (!local || local.runId !== runId || local.pending) return;
    if (local.depth > 1) {
      local.depth--;
      return;
    }

    active.delete(workspace);
    releaseExternal(workspace, runId);
    wakeNextWaiter(workspace);
  }

  export function markUnsafe(workspace: string, reason: string, token?: string): void {
    const state = markWorkspaceUnsafe(workspace, reason, token);
    if (state) rejectWaiters(workspace, unsafeWorkspaceError(workspace, state));
  }

  export function clearUnsafe(workspace: string, token?: string): void {
    clearWorkspaceUnsafe(workspace, token);
  }
}
