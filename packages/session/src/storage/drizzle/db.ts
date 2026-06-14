import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { initializeSqliteDatabase } from "../sqlite-schema-lifecycle";
import { drizzleSchema } from "./schema";

export type DrizzleDb = ReturnType<typeof drizzle<typeof drizzleSchema>>;

export function createDb(dbPath: string): { db: DrizzleDb; sqlite: Database } {
  const sqlite = new Database(dbPath);

  try {
    initializeSqliteDatabase(sqlite);

    const db = drizzle(sqlite, { schema: drizzleSchema });
    return { db, sqlite };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}
