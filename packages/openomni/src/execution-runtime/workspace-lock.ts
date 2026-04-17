type Waiter = { runId: string; resolve: () => void; reject: (e: Error) => void };

const active = new Map<string, string>();
const queue = new Map<string, Waiter[]>();

export namespace WorkspaceLock {
  export async function acquire(
    workspace: string,
    runId: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    if (!active.has(workspace)) {
      active.set(workspace, runId);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const entry: Waiter = {
        runId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };

      const timer = setTimeout(() => {
        const waiters = queue.get(workspace);
        if (waiters) {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
        }
        reject(new Error(`workspace lock timeout after ${timeoutMs}ms for "${workspace}"`));
      }, timeoutMs);

      const waiters = queue.get(workspace) ?? [];
      waiters.push(entry);
      queue.set(workspace, waiters);
    });
  }

  export function release(workspace: string, runId: string): void {
    if (active.get(workspace) !== runId) return;

    active.delete(workspace);

    const waiters = queue.get(workspace);
    if (!waiters || waiters.length === 0) {
      queue.delete(workspace);
      return;
    }

    const next = waiters.shift();
    if (!next) return;
    if (waiters.length === 0) queue.delete(workspace);
    active.set(workspace, next.runId);
    next.resolve();
  }
}
