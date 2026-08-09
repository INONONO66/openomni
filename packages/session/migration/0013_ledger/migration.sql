-- #510 Phase A: clean-ledger baseline tables. Hand-written from the DDL
-- source of truth src/ledger-core/schema.ts (drizzle-kit is generator-only;
-- when its output differs, this hand SQL wins). Applied by the existing
-- BEGIN IMMEDIATE migration runner.

CREATE TABLE IF NOT EXISTS ledger_event (
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  PRIMARY KEY (stream_id, seq)
);

CREATE TABLE IF NOT EXISTS ledger_head (
  stream_id TEXT PRIMARY KEY,
  head INTEGER NOT NULL
);
