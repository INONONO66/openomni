-- Durable delegation records: admission commits this row before transport work
-- begins; the kernel settles it through the open-to-settled CAS only.
CREATE TABLE IF NOT EXISTS delegation (
  delegation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open', 'settled')),
  root_delegation_id TEXT NOT NULL,
  wait_id TEXT,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_delegation_open_root
  ON delegation(root_delegation_id, time_created)
  WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_wait
  ON delegation(wait_id)
  WHERE wait_id IS NOT NULL;
