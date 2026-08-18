CREATE TABLE IF NOT EXISTS app_connector_installation (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_connector_installation_connector
  ON app_connector_installation(connector_id);

CREATE INDEX IF NOT EXISTS idx_app_connector_installation_status
  ON app_connector_installation(status);
