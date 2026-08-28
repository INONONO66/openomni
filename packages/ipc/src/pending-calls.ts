/**
 * Request-id correlation registry for in-flight IPC calls — the single
 * owner of the pending-call Map that client.ts and server.ts used to
 * hand-roll separately. One entry per outbound request: its promise
 * controls, the per-request timeout timer, and optional caller metadata
 * (the server stores the owning connectionId, so a dying connection fails
 * only ITS calls and a response is honored only on the connection that
 * asked for it).
 *
 * Timer hygiene is this module's job: every path that removes an entry —
 * settle, timeout, failAll — clears that entry's timer first.
 */

type PendingEntry<TMeta> = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  meta: TMeta;
};

export class PendingCalls<TMeta = undefined> {
  private readonly pending = new Map<string, PendingEntry<TMeta>>();

  /** Number of in-flight calls (test/diagnostic surface). */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Registers one outbound call under `id` and arms its per-request
   * timeout. The returned promise settles through settle()/failAll(), or
   * rejects with `timeoutError()` when the timeout fires first — the
   * entry is dropped either way, so a late response finds nothing.
   *
   * `options.send` dispatches the request frame AFTER the entry is
   * stored, still inside the promise executor: a throwing send rejects
   * the call instead of escaping synchronously, exactly like an inline
   * executor would.
   */
  register(
    id: string,
    timeoutMs: number,
    timeoutError: () => Error,
    options?: {
      /** Caller metadata stored on the entry and handed to `where` predicates. */
      meta?: TMeta;
      send?: () => void;
    },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError());
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, meta: options?.meta as TMeta });
      options?.send?.();
    });
  }

  /**
   * Settles the call registered under `id`. Returns false — leaving the
   * entry untouched — when the id is unknown or `where` rejects its
   * metadata (e.g. a response arriving on a connection that never asked).
   */
  settle(
    id: string,
    outcome:
      | { readonly ok: true; readonly value: unknown }
      | { readonly ok: false; readonly error: Error },
    where?: (meta: TMeta) => boolean,
  ): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    if (where && !where(entry.meta)) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (outcome.ok) {
      entry.resolve(outcome.value);
    } else {
      entry.reject(outcome.error);
    }
    return true;
  }

  /**
   * Rejects in-flight calls with `err` and clears their timers — every
   * call, or only those whose metadata matches `where` (the server's
   * per-connection teardown).
   */
  failAll(err: Error, where?: (meta: TMeta) => boolean): void {
    for (const [id, entry] of this.pending) {
      if (where && !where(entry.meta)) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(err);
    }
  }
}
