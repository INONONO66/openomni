-- Successful owner-session wake delivery receipt. NULL is deliberately
-- retryable: boot recovery re-delivers every settled non-inline row without it.
ALTER TABLE delegation ADD COLUMN woken_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_delegation_settled_unwoken
  ON delegation(settled_at)
  WHERE status = 'settled' AND woken_at IS NULL;
