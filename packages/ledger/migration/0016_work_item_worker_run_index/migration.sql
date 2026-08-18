-- #606 M5: telemetry session attribution (bus-persistence/session-id.ts)
-- resolves a payload's workerRunId to its workSessionId by querying
-- json_extract(data, '$.workerRunId') on work_item for EVERY persisted
-- run-scoped bus event. Without an expression index that read is a full
-- table scan per event. json_extract is deterministic, so SQLite can index
-- the expression directly; the query planner matches it because the query
-- uses the identical expression text.
CREATE INDEX IF NOT EXISTS idx_work_item_worker_run_id
  ON work_item(json_extract(data, '$.workerRunId'));
