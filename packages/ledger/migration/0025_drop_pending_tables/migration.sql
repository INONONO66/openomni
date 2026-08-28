-- Frozen legacy pending-* stack removal: pending_ask (#510 D2a) and
-- pending_interaction (#548) had every write frozen behind typed errors and
-- their only remaining reader was the gateway router's legacy correlation
-- fallback, which no producible deployment can ever hit (the sole deployable
-- app has never wired a pending writer, so no rows can exist). The read
-- stack is deleted with this migration; 0017 precedent — keeping dead tables
-- in the durability kernel invites writes outside the ledger discipline.
--
-- Archive-before-delete guard (#510): the drop only proceeds over EMPTY
-- tables. A row in either table violates the CHECK below, the migration
-- transaction rolls back, and boot fails loudly — the operator archives the
-- rows (script/generate-ledger-archive-manifest.ts at a pre-0025 revision)
-- before this migration may run.
CREATE TABLE _pending_drop_guard (row_count INTEGER NOT NULL CHECK (row_count = 0));
INSERT INTO _pending_drop_guard SELECT COUNT(*) FROM pending_ask;
INSERT INTO _pending_drop_guard SELECT COUNT(*) FROM pending_interaction;
DROP TABLE _pending_drop_guard;
DROP TABLE pending_interaction;
DROP TABLE pending_ask;
