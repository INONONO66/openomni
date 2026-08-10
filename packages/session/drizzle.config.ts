import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit is a GENERATOR ONLY (#510 / blueprint "Storage decisions"):
 * src/ledger-core/schema.ts is the DDL source of truth, generated output is
 * a drift check, and the DDL that actually applies is the hand-written
 * migration/0013_ledger/migration.sql run by the existing BEGIN IMMEDIATE
 * migration runner. Never wire drizzle-kit migrate/push at runtime.
 *
 * `casing` must stay identical to createLedgerDb (test/ledger-core/db.ts).
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/ledger-core/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
});
