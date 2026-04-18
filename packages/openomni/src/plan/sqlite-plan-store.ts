import type { Database } from "bun:sqlite";
import { Hashline } from "./hashline.js";
import type { PlanDocument, EditResult, PlanStore } from "./plan-store.js";

type PlanRow = {
  content: string;
  version: number;
  time_created: number;
  time_updated: number;
};

const PLAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS plan (
  id           TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
`;

export class SqlitePlanStore implements PlanStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(PLAN_SCHEMA);
  }

  write(planId: string, content: string): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO plan (id, content, version, time_created, time_updated)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           version = plan.version + 1,
           time_updated = excluded.time_updated`,
      )
      .run(planId, content, now, now);
  }

  read(planId: string): PlanDocument | undefined {
    const row = this.db
      .query<PlanRow, [string]>(
        "SELECT content, version, time_created, time_updated FROM plan WHERE id = ?",
      )
      .get(planId);
    if (!row) return undefined;
    return {
      planId,
      content: row.content,
      version: row.version,
      createdAt: row.time_created,
      updatedAt: row.time_updated,
    };
  }

  edit(planId: string, edits: Hashline.EditOp[]): EditResult {
    const doc = this.read(planId);
    if (!doc) return { ok: false, errors: [`Plan not found: ${planId}`] };

    const result = Hashline.applyEdits(doc.content, edits);
    if (!result.ok) return result;

    this.write(planId, result.content);
    return { ok: true, content: result.content };
  }

  delete(planId: string): boolean {
    const existing = this.read(planId);
    if (!existing) return false;
    this.db.query("DELETE FROM plan WHERE id = ?").run(planId);
    return true;
  }
}
