ALTER TABLE bus_event ADD COLUMN payload_status TEXT
  CHECK (payload_status IN ('valid', 'invalid', 'parse_failed'));
ALTER TABLE bus_event ADD COLUMN payload_diagnostic TEXT;
