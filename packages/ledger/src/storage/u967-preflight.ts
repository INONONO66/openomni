import { canonicalDigest } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

export const U967_MIGRATION = "0034_u967_archive_disposition/migration.sql";
export const RETIRED_TABLE_MIGRATION = "0035_drop_retired_delegation_tables/migration.sql";
export const REPLY_GRANT_MIGRATION = "0036_reply_grant_projection/migration.sql";

export class U967Error extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "U967Error";
  }
}

export function sqliteSchema(db: Database) {
  return db
    .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
      "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name",
    )
    .all();
}

// Fingerprints of the shipped immutable chain, captured from the existing
// runner. A marker list alone cannot attest an initialized schema.
const SCHEMA_0033 = "sha256:3a6ab3e2b91321743f5309a59cec69064f300b956e3a6237a2c4de4917c93ca1";
const SCHEMA_0034 = "sha256:47900a330291d08e53bf50a9a1dc34b5314aa13a1341f04a2fba95114416fa2d";
const SCHEMA_0035 = "sha256:7cc06095957973ceb27c8a1cd2eef1cecc01c04f4f8c7e5dca57dc22f3250e14";
const SCHEMA_0036 = "sha256:89e7677fe96971ec5ff5f8176504f42a478ae4fd8dfa84e4e18560077279e0ff";

export function preflight967(db: Database, migrations: readonly { readonly name: string }[]) {
  const schema = sqliteSchema(db);
  if (schema.length === 0) return "fresh";
  if (!schema.some((row) => row.name === "_migrations")) throw new U967Error("unsupported_upgrade");
  const history = db
    .query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY rowid")
    .all();
  const latest = history.at(-1)?.name;
  const applied =
    latest === U967_MIGRATION ||
    latest === RETIRED_TABLE_MIGRATION ||
    latest === REPLY_GRANT_MIGRATION;
  const latestIndex =
    latest === undefined ? -1 : migrations.findIndex((migration) => migration.name === latest);
  const expected = latestIndex < 0 ? migrations.slice(0, -1) : migrations.slice(0, latestIndex + 1);
  const schemaDigest =
    latest === REPLY_GRANT_MIGRATION
      ? SCHEMA_0036
      : latest === RETIRED_TABLE_MIGRATION
        ? SCHEMA_0035
        : applied
          ? SCHEMA_0034
          : SCHEMA_0033;
  if (
    canonicalDigest(history) !== canonicalDigest(expected) ||
    canonicalDigest(schema) !== schemaDigest
  ) {
    throw new U967Error("unsupported_upgrade");
  }
  return applied ? "applied" : "pending";
}
