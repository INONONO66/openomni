import { expect } from "bun:test";
import { Database } from "bun:sqlite";

export function assertNoLegacyRequestStores(dbPath: string): void {
  using db = new Database(dbPath, { readonly: true });
  expect(
    db
      .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('wait','approval')")
      .all(),
  ).toEqual([]);
}

export function persistedSession(raw: Database, id: string) {
  return {
    session: raw.query("SELECT * FROM session WHERE id = ?").get(id),
    actions: raw.query("SELECT * FROM action WHERE session_id = ? ORDER BY ordinal").all(id),
    inbox: raw.query("SELECT * FROM inbox WHERE session_id = ?").all(id),
  };
}
