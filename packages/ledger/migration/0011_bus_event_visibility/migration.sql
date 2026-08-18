ALTER TABLE bus_event ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal';
CREATE INDEX IF NOT EXISTS idx_bus_event_visibility_session ON bus_event(visibility, session_id, time_created);
