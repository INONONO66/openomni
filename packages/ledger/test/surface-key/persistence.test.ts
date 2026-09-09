import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SurfaceKey } from "../../src/surface-key";
import { createSqliteSurfaceKeyAdapter } from "../../src/storage/sqlite-surface-key-adapter";
import "../../src/storage/initialize";
import { materializeSession } from "../helpers/session";
import { useSqliteStorage } from "../helpers/storage";

describe("SurfaceKey SQLite persistence", () => {
  const fixture = useSqliteStorage("surface-key");

  test("persists across Storage re-init", () => {
    const session = materializeSession("persist-test");
    SurfaceKey.claim("telegram:bot:chat:123", session.id);

    fixture.reopen();

    expect(SurfaceKey.lookup("telegram:bot:chat:123")).toBe(session.id);
  });

  test("re-claim with expected owner updates session in SQLite", () => {
    const session1 = materializeSession("old-session");
    const session2 = materializeSession("new-session");
    SurfaceKey.claim("slack:ws:channel:C1", session1.id);
    SurfaceKey.claim("slack:ws:channel:C1", session2.id, session1.id);

    fixture.reopen();

    expect(SurfaceKey.lookup("slack:ws:channel:C1")).toBe(session2.id);
  });

  test("claim throws loudly when the row is missing after INSERT OR IGNORE", () => {
    // Impossible-state simulation: a trigger deletes every inserted row, so
    // the read-back inside claim's own transaction finds nothing. The old
    // `row?.session_id ?? sessionId` fallback silently fabricated ownership
    // for exactly this unreachable state.
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE surface_key (
         key TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         time_created INTEGER NOT NULL
       );
       CREATE TRIGGER surface_key_vanish AFTER INSERT ON surface_key
       BEGIN
         DELETE FROM surface_key WHERE key = NEW.key;
       END;`,
    );
    const adapter = createSqliteSurfaceKeyAdapter(db);

    expect(() => adapter.claim("telegram:bot:chat:123", "ses-1")).toThrow(
      "surface_key row missing after INSERT OR IGNORE",
    );
    db.close();
  });
});
