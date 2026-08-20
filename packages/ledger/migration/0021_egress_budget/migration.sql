-- #219 active-egress gate — the durable debit ledger (gateway-design §4).
--
-- Perimeter-domain surface: the channels gateway router (the send kernel) is
-- the sole writer (S8), like the wait store. Append-only — one row per ADMITTED
-- proactive send. The budget evaluator folds a window projection off these rows
-- (count in window, per-class counts, and the last-send-at cooldown clock);
-- there is no update or delete path (a debit, once recorded, is immutable).
CREATE TABLE IF NOT EXISTS egress_debit (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  target_actor_id TEXT NOT NULL,
  class TEXT NOT NULL,
  at INTEGER NOT NULL,
  time_created INTEGER NOT NULL
);

-- The one read shape: fold the window/cooldown projection for a (sender,
-- target) pair ordered by send time.
CREATE INDEX IF NOT EXISTS idx_egress_debit_pair_at
  ON egress_debit(sender_id, target_actor_id, at);
