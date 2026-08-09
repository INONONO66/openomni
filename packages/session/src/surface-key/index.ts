/**
 * SurfaceKey index: N:1 mapping from surface-specific keys to session IDs.
 * Provides bidirectional lookup for routing events to sessions.
 *
 * Key format: `<surface-type>:<surface-specific-path>`
 *
 * Channel/peer kind encoding:
 *   - DM:      slack:workspaceA:dm:U123
 *   - Group:   slack:workspaceA:group:C123
 *   - Thread:  slack:workspaceA:group:C123:thread:171000
 *   - Channel: slack:workspaceA:channel:C123
 *   - TUI:     tui:/Users/ino/Develop/OpenOmni
 *   - Chat:    telegram:botId:chat:chatId
 *
 * The `ChannelKind` type defines recognized channel/peer kinds.
 * Use `SurfaceKey.fromChannel()` for structured creation with explicit kind.
 *
 * Storage: uses Storage.Adapter.surfaceKey (SQLite); a missing sub-adapter
 * fails closed — routing must never fabricate ownership answers (#522).
 */

import { requireSubAdapter } from "../storage/timestamped-store";
import { Storage } from "../storage/storage";

type ChannelKind = "dm" | "group" | "channel" | "thread" | "chat";

interface ParsedKey {
  readonly surface: string;
  readonly namespace: string;
  readonly kind: ChannelKind | undefined;
  readonly id: string | undefined;
  readonly threadId: string | undefined;
}

export namespace SurfaceKey {
  export interface ChannelDescriptor {
    /** Surface type (e.g., "slack", "telegram", "tui") */
    surface: string;
    /** Namespace/workspace/bot identifier */
    namespace: string;
    kind: ChannelKind;
    id: string;
    /** Optional thread identifier (creates a sub-key under the channel) */
    threadId?: string;
  }

  function validateFormat(key: string): boolean {
    return key.includes(":");
  }

  /**
   * Create a surfaceKey from parts.
   * @param parts - Array of strings to join with colons
   * @returns Formatted surfaceKey
   * @throws Error if parts is empty or validation fails
   */
  export function create(parts: string[]): string {
    if (parts.length === 0) {
      throw new Error("SurfaceKey parts cannot be empty");
    }

    const key = parts.join(":");

    if (!validateFormat(key)) {
      throw new Error(
        `Invalid surfaceKey format: "${key}". Must include surface type prefix (e.g., "slack:...")`,
      );
    }

    return key;
  }

  const KNOWN_KINDS: ReadonlySet<string> = new Set<ChannelKind>([
    "dm",
    "group",
    "channel",
    "thread",
    "chat",
  ]);

  export function fromChannel(descriptor: ChannelDescriptor): string {
    const parts = [descriptor.surface, descriptor.namespace, descriptor.kind, descriptor.id];
    if (descriptor.threadId) {
      parts.push("thread", descriptor.threadId);
    }
    return create(parts);
  }

  export function parse(key: string): ParsedKey {
    const segments = key.split(":");
    const surface = segments[0] ?? "";
    const namespace = segments[1] ?? "";

    let kind: ChannelKind | undefined;
    let id: string | undefined;
    let threadId: string | undefined;

    for (let i = 2; i < segments.length; i++) {
      const seg = segments[i];
      if (seg == null) {
        continue;
      }
      if (KNOWN_KINDS.has(seg)) {
        if (seg === "thread") {
          threadId = segments[i + 1];
          i++;
        } else {
          kind = seg as ChannelKind;
          id = segments[i + 1];
          i++;
        }
      }
    }

    return { surface, namespace, kind, id, threadId };
  }

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
    if (!validateFormat(key)) {
      throw new Error(
        `Invalid surfaceKey format: "${key}". Must include surface type prefix (e.g., "slack:...")`,
      );
    }

    subAdapter().register(key, sessionId);
  }

  /**
   * Attempt to claim a surfaceKey for a session without clobbering a concurrent owner.
   * With expectedSessionId, replaces only if the current owner still equals it.
   * Without expectedSessionId, inserts only when the key is absent.
   * Returns the session ID that owns the key after the claim attempt.
   */
  export function claim(key: string, sessionId: string, expectedSessionId?: string): string {
    if (!validateFormat(key)) {
      throw new Error(
        `Invalid surfaceKey format: "${key}". Must include surface type prefix (e.g., "slack:...")`,
      );
    }

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
