CREATE INDEX IF NOT EXISTS idx_message_session_time ON message(session_id, time_created, id);

CREATE INDEX IF NOT EXISTS idx_part_message_id ON part(message_id, id);
