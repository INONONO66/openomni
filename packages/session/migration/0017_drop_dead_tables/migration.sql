-- #606 dead-surface removal: these seven tables have had zero readers and
-- zero writers anywhere in packages/ or apps/ since their owning features
-- moved to the WorkItem projection + ledger (task*, plan, todo,
-- background_task) or to bus_event (event_log). Keeping empty tables in the
-- durability kernel's schema is a standing invitation to write decision
-- state outside the ledger discipline, so they go. Children drop before
-- parents (task_idempotency -> task_run -> task) to satisfy FK enforcement.
DROP TABLE IF EXISTS task_idempotency;
DROP TABLE IF EXISTS task_run;
DROP TABLE IF EXISTS task;
DROP TABLE IF EXISTS event_log;
DROP TABLE IF EXISTS plan;
DROP TABLE IF EXISTS todo;
DROP TABLE IF EXISTS background_task;
