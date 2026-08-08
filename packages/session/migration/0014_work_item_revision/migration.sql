-- #510 C1: WorkItem head binding — the decision-class fact at stream
-- `work:<hash>` seq N produces work item revision N, so the projection row
-- carries its revision as a physical CAS column (the previous CAS matched
-- json_extract(data, '$.revision')).
--
-- Backfill: a pre-cutover row's transition count cannot be recovered, so
-- every existing row is backfilled to revision 1 (column AND payload) and
-- starts its owner stream at the observed state — the first post-cutover
-- transition lazily appends a `work_item.adopted` genesis fact (seq 1)
-- carrying the adopted snapshot. This keeps expectedHead semantics sound
-- without fabricating history.

ALTER TABLE work_item ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

UPDATE work_item SET revision = 1, data = json_set(data, '$.revision', 1);
