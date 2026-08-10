-- #547 C3: append-only Transcript.Fact rows — the transcript record family.
-- The per-session fact stream is the durable conversation record; the
-- message/part tables become fold projections of it (read models).
--
-- Deliberately NOT ledger_event: transcript facts are recording tier per the
-- kernel contract (they record what the stream did, they never authorize an
-- action), so they must not compete on decision-class CAS heads or grow the
-- boot-verified hash chain with streaming-volume rows. Fact and projection
-- still commit as one fsync unit: the store appends here INSIDE the same
-- BEGIN IMMEDIATE storage transaction as the projection write, on the
-- synchronous=FULL primary connection (see src/session/transcript.ts).
--
-- The composite PK (session_id, seq) is the backstop against seq reuse; the
-- table carries no UPDATE path by design — later lifecycle steps are NEW
-- part.advanced facts, never rewrites of stored rows.

CREATE TABLE IF NOT EXISTS transcript_fact (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- Record-path validation folds one attempt's facts (attempt boundary =
-- state boundary), so the attempt read must not scan the session stream.
CREATE INDEX IF NOT EXISTS idx_transcript_fact_attempt
  ON transcript_fact (session_id, attempt_id, seq);
