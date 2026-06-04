import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { initializeSqliteDatabase } from "../sqlite-schema-lifecycle";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(dbPath: string): { db: DrizzleDb; sqlite: Database } {
  const sqlite = new Database(dbPath);

  try {
    initializeSqliteDatabase(sqlite);

    const db = drizzle(sqlite, { schema });
    return { db, sqlite };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}
