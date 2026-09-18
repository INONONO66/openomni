import { Database } from "bun:sqlite";

// Contender process for the 967 lock test: one immediate write transaction
// against the database at argv[2], with no busy wait, so a held lock surfaces
// as "database is locked" and exit 1.
using db = new Database(process.argv[2]);
db.run("PRAGMA busy_timeout=0");
db.run("BEGIN IMMEDIATE");
db.run("ROLLBACK");
