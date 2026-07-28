import { createAbortError, throwIfAborted } from "./workspace-lock-abort.js";
import { acquireExternal, releaseExternal } from "./workspace-lock-files.js";
import type { LocalWorkspaceLock, WorkspaceLockWaiter } from "./workspace-lock-types.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";

const active = new Map<string, LocalWorkspaceLock>();
const queue = new Map<string, WorkspaceLockWaiter[]>();

function wakeNextWaiter(workspaceId: string): void {
  const waiters = queue.get(workspaceId);
  if (!waiters || waiters.length === 0) {
    queue.delete(workspaceId);
    return;
  }

  const next = waiters.shift();
  if (waiters.length === 0) queue.delete(workspaceId);
  if (!next) return;

  active.set(workspaceId, { runId: next.runId, depth: 0, pending: true });
  next.resolve();
}

export namespace WorkspaceLock {
  export async function acquire(
    workspace: WorkspaceIdentity,
    runId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const workspaceId = workspace.workspaceId;
    const local = active.get(workspaceId);
    if (local && !local.pending && local.runId === runId) {
      local.depth++;
      return;
    }

    if (!local && (queue.get(workspaceId)?.length ?? 0) === 0) {
      await acquireExternal(workspace, runId, timeoutMs, signal);
      if (signal?.aborted) {
        releaseExternal(workspace, runId);
        throw createAbortError();
      }
      active.set(workspaceId, { runId, depth: 1, pending: false });
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
        const waiters = queue.get(workspaceId);
        if (waiters) {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) queue.delete(workspaceId);
        }
        reject(new Error(`workspace lock timeout after ${timeoutMs}ms for "${workspaceId}"`));
      }, timeoutMs);
      const onAbort = () => {
        const waiters = queue.get(workspaceId);
        if (waiters) {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) queue.delete(workspaceId);
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

      const waiters = queue.get(workspaceId) ?? [];
      waiters.push(entry);
      queue.set(workspaceId, waiters);
    });

    const remaining = Math.max(0, timeoutMs - (Date.now() - start));
    try {
      await acquireExternal(workspace, runId, remaining, signal);
      if (signal?.aborted) {
        releaseExternal(workspace, runId);
        throw createAbortError();
      }
      active.set(workspaceId, { runId, depth: 1, pending: false });
    } catch (error) {
      const current = active.get(workspaceId);
      if (current?.runId === runId && current.pending) {
        active.delete(workspaceId);
        wakeNextWaiter(workspaceId);
      }
      throw error;
    }
  }

  export function release(workspace: WorkspaceIdentity, runId: string): void {
    const workspaceId = workspace.workspaceId;
    const local = active.get(workspaceId);
    if (!local || local.runId !== runId || local.pending) return;
    if (local.depth > 1) {
      local.depth--;
      return;
    }

    active.delete(workspaceId);
    releaseExternal(workspace, runId);
    wakeNextWaiter(workspaceId);
  }
}
