-- Paired post-step (migrateDecisionFacts, same transaction): re-records each
-- retired stream head into decision_fact after validation, then executes
-- DROP TABLE ledger_event;
-- DROP TABLE ledger_head;
-- atomically with the statements below. Recorded here because migration SQL
-- is the schema-origin record for created and dropped tables.
CREATE TABLE decision_fact (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  time_created INTEGER NOT NULL
);
