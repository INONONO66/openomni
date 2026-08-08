-- #510 C1: WorkItem head binding — the decision-class fact at stream
-- `work:<hash>` seq N produces work item revision N, so the projection row
-- carries its revision as a physical CAS column (the previous CAS matched
-- json_extract(data, '$.revision')).
--
-- Backfill (review fix F4): the legacy json revision counted transitions
-- 0-based (create wrote 0), the fact-bound scheme is 1-based (created fact
-- is seq 1 == revision 1). Every existing row shifts to old json revision
-- + 1 — column AND json payload in lockstep — so the transition count IS
-- preserved and the created-only remove guard (revision === 1) keeps its
-- meaning. Pre-cutover rows therefore sit at revision >= 1 with an EMPTY
-- owner stream; their first post-cutover transition adopts the stream at
-- the observed revision (`work_item.adopted` genesis fact at seq ===
-- revision via Ledger.adoptStream) — history is adopted, never fabricated.
--
-- Recorded-head caveat: completion admissions persisted before this
-- migration recorded `expectedHead`/`recordedHead` against the OLD 0-based
-- revisions. An in-flight (non-terminal) completion resumed after the shift
-- can therefore fail its head check; boot recovery surfaces each such
-- failure as a loud Operational.Error carrying the work item id instead of
-- swallowing it (apps/server/src/bootstrap/recovery.ts).

ALTER TABLE work_item ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

UPDATE work_item
SET revision = COALESCE(json_extract(data, '$.revision'), 0) + 1,
    data = json_set(data, '$.revision', COALESCE(json_extract(data, '$.revision'), 0) + 1);
