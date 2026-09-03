-- Dormant storage removal (#944): these tables have no production readers or
-- writers after TranscriptStore, AppConnectorInstallationStore, and the old
-- cron adapter were deleted. Refuse to discard unexpected durable data; an
-- operator must archive it before retrying the migration.
CREATE TABLE _dormant_drop_guard (row_count INTEGER NOT NULL CHECK (row_count = 0));
INSERT INTO _dormant_drop_guard SELECT COUNT(*) FROM transcript_fact;
INSERT INTO _dormant_drop_guard SELECT COUNT(*) FROM app_connector_installation;
INSERT INTO _dormant_drop_guard SELECT COUNT(*) FROM cron_job;
DROP TABLE _dormant_drop_guard;
DROP TABLE transcript_fact;
DROP TABLE app_connector_installation;
DROP TABLE cron_job;
