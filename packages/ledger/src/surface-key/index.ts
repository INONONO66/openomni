/**
 * SurfaceKey store: N:1 mapping from surface-specific keys to session IDs.
 * Provides bidirectional lookup for routing events to sessions.
 *
 * Storage semantics only — the pure string codec (parse/fromChannel/create
 * and the key-format documentation) lives in the protocol adapter domain
 * (`Channel.SurfaceKey`, #499 precursor); this store imports it for format
 * validation.
 *
 * Storage: uses Storage.Adapter.surfaceKey (SQLite); a missing sub-adapter
 * fails closed — routing must never fabricate ownership answers (#522).
 */

import { Channel } from "@openomni/protocol";
import { requireSubAdapter } from "../storage/timestamped-store";
import { Storage } from "../storage/storage";

export namespace SurfaceKey {
  function subAdapter(): NonNullable<Storage.Adapter["surfaceKey"]> {
    return requireSubAdapter(
      Storage.get().surfaceKey,
      "Storage adapter does not implement surfaceKey — surface-key routing fails closed",
    );
  }

  export function lookup(key: string): string | undefined {
    return subAdapter().lookup(key);
  }

  /**
   * Attempt to claim a surfaceKey for a session without clobbering a concurrent owner.
   * With expectedSessionId, replaces only if the current owner still equals it.
   * Without expectedSessionId, inserts only when the key is absent.
   * Returns the session ID that owns the key after the claim attempt.
   */
  export function claim(key: string, sessionId: string, expectedSessionId?: string): string {
    Channel.SurfaceKey.assertWellFormed(key);
    return subAdapter().claim(key, sessionId, expectedSessionId);
  }

  export function listBySession(sessionId: string): string[] {
    return subAdapter().listBySession(sessionId);
  }
}
