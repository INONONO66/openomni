/**
 * SurfaceKey store: N:1 mapping from surface-specific keys to session IDs.
 * Provides bidirectional lookup for routing events to sessions.
 *
 * Storage semantics only — the pure string codec (parse/fromChannel/create
 * and the key-format documentation) lives in the protocol adapter domain
 * (`Adapter.SurfaceKey`, #499 precursor); this store imports it for format
 * validation.
 *
 * Storage: uses Storage.Adapter.surfaceKey (SQLite); a missing sub-adapter
 * fails closed — routing must never fabricate ownership answers (#522).
 */

import { Adapter } from "@openomni/protocol";
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
   * Register a surfaceKey → sessionId mapping.
   * Supports N:1 mapping (multiple keys can point to same session).
   * @param key - The surfaceKey
   * @param sessionId - The session ID
   */
  export function register(key: string, sessionId: string): void {
    Adapter.SurfaceKey.assertWellFormed(key);
    subAdapter().register(key, sessionId);
  }

  /**
   * Attempt to claim a surfaceKey for a session without clobbering a concurrent owner.
   * With expectedSessionId, replaces only if the current owner still equals it.
   * Without expectedSessionId, inserts only when the key is absent.
   * Returns the session ID that owns the key after the claim attempt.
   */
  export function claim(key: string, sessionId: string, expectedSessionId?: string): string {
    Adapter.SurfaceKey.assertWellFormed(key);
    return subAdapter().claim(key, sessionId, expectedSessionId);
  }

  /**
   * Unregister a surfaceKey.
   * @param key - The surfaceKey to unregister
   * @returns true if key was found and removed, false otherwise
   */
  export function unregister(key: string): boolean {
    const sk = subAdapter();
    const sessionId = sk.lookup(key);
    if (!sessionId) return false;
    sk.delete(key);
    return true;
  }

  /**
   * List all surfaceKeys registered for a given session.
   * @param sessionId - The session ID
   * @returns Array of surfaceKeys for this session
   */
  export function listBySession(sessionId: string): string[] {
    return subAdapter().listBySession(sessionId);
  }
}
