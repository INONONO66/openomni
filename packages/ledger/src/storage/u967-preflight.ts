import { canonicalDigest } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

export const U967_MIGRATION = "0034_u967_archive_disposition/migration.sql";

export class U967Error extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "U967Error";
  }
}

export function sqliteSchema(db: Database) {
  return db.query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name",
  ).all();
}

// Fingerprints of the shipped immutable chain, captured from the existing
// runner. A marker list alone cannot attest an initialized schema.
const SCHEMA_0033 = "sha256:3a6ab3e2b91321743f5309a59cec69064f300b956e3a6237a2c4de4917c93ca1";
const SCHEMA_0034 = "sha256:47900a330291d08e53bf50a9a1dc34b5314aa13a1341f04a2fba95114416fa2d";

export function preflight967(db: Database, migrations: readonly { readonly name: string }[]) {
  const schema = sqliteSchema(db);
  if (schema.length === 0) return "fresh";
  if (!schema.some((row) => row.name === "_migrations")) throw new U967Error("unsupported_upgrade");
  const history = db.query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY rowid").all();
  const last = history.at(-1)?.name;
  const watches = last === "0035_watch_alarms/migration.sql";
  const applied = watches || last === U967_MIGRATION;
  const boundary = migrations.findIndex((migration) => migration.name === U967_MIGRATION);
  const expected = migrations.slice(0, watches ? boundary + 2 : applied ? boundary + 1 : boundary);
  const fingerprint = watches ? "sha256:3e3f4978b3ab09d0dc06868119799ef6f1934e990f5da4ed33faf61cd54f33dc" : applied ? SCHEMA_0034 : SCHEMA_0033;
  if (canonicalDigest(history) !== canonicalDigest(expected)
    || canonicalDigest(schema) !== fingerprint) {
    throw new U967Error("unsupported_upgrade");
  }
  return applied ? "applied" : "pending";
}
