ALTER TABLE message ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
CREATE INDEX IF NOT EXISTS idx_message_status ON message(session_id, status);
