import { join } from "node:path";
import { homedir } from "node:os";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { SurfaceKey, Session } from "@openomni/session";

const STORE_PATH = join(homedir(), ".openomni", "surface-keys.json");

/**
 * Persistent wrapper around in-memory SurfaceKey.
 *
 * On boot, restores surfaceKey->sessionId mappings from disk into the
 * in-memory index (validating each session still exists). On register,
 * writes through to both memory and disk.
 */
export namespace SurfaceStore {
  export function initialize(): void {
    const mappings = load();
    let restored = 0;

    for (const [key, sessionId] of Object.entries(mappings)) {
      const session = Session.get(sessionId);
      if (session) {
        SurfaceKey.register(key, sessionId);
        restored++;
      }
    }

    // Save cleaned mappings (remove stale entries)
    if (restored < Object.keys(mappings).length) {
      const cleaned: Record<string, string> = {};
      for (const [key, sessionId] of Object.entries(mappings)) {
        if (Session.get(sessionId)) {
          cleaned[key] = sessionId;
        }
      }
      save(cleaned);
    }

    if (restored > 0) {
      console.log(`[surface] Restored ${restored} surface key mapping(s)`);
    }
  }

  export function register(key: string, sessionId: string): void {
    SurfaceKey.register(key, sessionId);
    const mappings = load();
    mappings[key] = sessionId;
    save(mappings);
  }

  export function lookup(key: string): string | undefined {
    return SurfaceKey.lookup(key);
  }

  function load(): Record<string, string> {
    if (!existsSync(STORE_PATH)) return {};
    try {
      return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    } catch {
      return {};
    }
  }

  function save(mappings: Record<string, string>): void {
    const tmpPath = STORE_PATH + ".tmp";
    try {
      mkdirSync(join(homedir(), ".openomni"), { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(mappings, null, 2) + "\n");
      renameSync(tmpPath, STORE_PATH);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {}
      throw err;
    }
  }
}
