import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ledgerEvent, ledgerHead } from "../../src/ledger-core/schema";

const schema = { ledgerEvent, ledgerHead } as const;

/**
 * Drizzle client over the EXISTING bun:sqlite handle owned by the storage
 * adapter — same file, same connection discipline (pragmas, sync driver);
 * this factory never opens or configures a connection of its own. Casing
 * `snake_case` matches drizzle.config.ts so runtime mapping and generated
 * DDL agree with migration/0013_ledger/migration.sql.
 *
 * Phase A scope: drizzle is DDL/schema-parity surface only. Decision-class
 * runtime SQL (CAS, changes===1 receipt, hash chain) lives in append.ts /
 * chain.ts as raw prepared statements and must stay there.
 *
 * Test-only fixture: no production code consumes this factory, and the
 * ledger DDL drift gate (script/check-ledger-schema-drift.ts) consumes
 * schema.ts directly, not this client.
 */
export function createLedgerDb(db: Database) {
  return drizzle({ client: db, schema, casing: "snake_case" });
}
