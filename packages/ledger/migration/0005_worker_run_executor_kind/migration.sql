ALTER TABLE worker_run_state ADD COLUMN executor_kind TEXT;
UPDATE worker_run_state SET executor_kind = 'internal_chat_agent' WHERE executor_kind IS NULL;
