import type { QueryStats } from "./query-contracts.js";
import { getDatabase } from "./query-database.js";
import type { CategoryCountRow, CountRow, TypeCountRow } from "./query-rows.js";

export function getStats(sessionId: string): Promise<QueryStats> {
  const db = getDatabase();
  const total = db
    .query("SELECT COUNT(*) as count FROM bus_event WHERE session_id = ?")
    .get(sessionId) as CountRow;
  const categoryRows = db
    .query(
      "SELECT category, COUNT(*) as count FROM bus_event WHERE session_id = ? GROUP BY category",
    )
    .all(sessionId) as CategoryCountRow[];
  const typeRows = db
    .query(
      "SELECT event_type, COUNT(*) as count FROM bus_event WHERE session_id = ? GROUP BY event_type",
    )
    .all(sessionId) as TypeCountRow[];

  return Promise.resolve({
    totalEvents: total.count,
    byCategory: Object.fromEntries(categoryRows.map((row) => [row.category, row.count])),
    byType: Object.fromEntries(typeRows.map((row) => [row.event_type, row.count])),
  });
}
