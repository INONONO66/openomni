import type { Database } from "bun:sqlite";
import { SessionInfo } from "../session/info";
import type { Storage } from "./storage";

const maxSessionParseCacheEntries = 4096;

export function createSqliteSessionAdapter(db: Database): Storage.Adapter["session"] {
  const parseCache = new Map<string, string>();

  return {
    get: (id: string): SessionInfo | undefined => {
      const row = db.query("SELECT data FROM session WHERE id = ?").get(id) as {
        data: string;
      } | null;
      return row ? parseSessionInfo(row.data, parseCache) : undefined;
    },

    set: (id: string, info: SessionInfo): void => {
      db.query(
        `INSERT INTO session (id, data, time_created, time_updated)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           time_created = excluded.time_created,
           time_updated = excluded.time_updated`,
      ).run(id, JSON.stringify(info), info.time.created, info.time.updated);
    },

    list: (): SessionInfo[] => {
      const rows = db.query("SELECT data FROM session").all() as Array<{ data: string }>;
      return rows.map((r) => parseSessionInfo(r.data, parseCache));
    },

    remove: (id: string): boolean => {
      const result = db.query("DELETE FROM session WHERE id = ?").run(id);
      return result.changes > 0;
    },
  };
}

function parseSessionInfo(data: string, cache: Map<string, string>): SessionInfo {
  const cached = cache.get(data);
  if (cached !== undefined) {
    return JSON.parse(cached) as SessionInfo;
  }

  // The session table stores JSON snapshots; validate reads at the adapter boundary so
  // schema defaults, such as spawnDepth for pre-worker-run rows, are applied consistently.
  // Cache the normalized JSON by the exact stored payload to avoid paying Zod cost on hot
  // get/list paths while still returning fresh objects like a plain JSON.parse read.
  const parsed = SessionInfo.parse(JSON.parse(data));
  rememberParsedSessionInfo(cache, data, JSON.stringify(parsed));
  return parsed;
}

function rememberParsedSessionInfo(
  cache: Map<string, string>,
  data: string,
  normalized: string,
): void {
  if (cache.size >= maxSessionParseCacheEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(data, normalized);
}
