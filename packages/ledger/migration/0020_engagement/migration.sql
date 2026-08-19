-- #709 gateway stage 4 — the engagement machine (gateway-design §5).
--
-- Brain-domain surface (§4 SSOT): the brain is the sole writer; the gateway
-- sees only engagementId values carried on waitSpec correlation and
-- Gateway.WaitContext. The row is the CAS projection of the
-- `engagement:<id>` decision stream (append-before-CAS, the Wait/WorkItem
-- discipline); `data` holds the full Engagement.Record JSON and the flat
-- columns are query projections only.
CREATE TABLE IF NOT EXISTS engagement (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL,
  expires_at INTEGER,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_engagement_owner_state
  ON engagement(owner_session_id, state, time_created);
CREATE INDEX IF NOT EXISTS idx_engagement_state_expires
  ON engagement(state, expires_at);
