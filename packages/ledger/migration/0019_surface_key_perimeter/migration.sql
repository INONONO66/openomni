-- #707 stage 2: surface_key becomes a PERIMETER surface (gateway-domain).
-- The FK into session(id) was a cross-domain invariant the SSOT directive
-- forbids (docs/gateway-design.md §4): it forced the session ROW (brain
-- domain) to exist before the map claim (gateway domain), which contradicts
-- the flipped seam's record-before-act order — the gateway mints the
-- sessionId and claims the map BEFORE deliver; the brain lazily materializes
-- the row on first Deliver. Row values are unchanged (key, session_id,
-- time_created); only the constraint and the ON DELETE CASCADE coupling go.
-- A map entry whose session row was removed or expired is no longer deleted
-- behind the gateway's back: the next inbound converges by re-materializing
-- the same opaque label (idempotent create-if-absent).
CREATE TABLE surface_key_perimeter (
  key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL
);
INSERT INTO surface_key_perimeter (key, session_id, time_created)
  SELECT key, session_id, time_created FROM surface_key;
DROP TABLE surface_key;
ALTER TABLE surface_key_perimeter RENAME TO surface_key;
CREATE INDEX IF NOT EXISTS idx_surface_key_session ON surface_key(session_id);
