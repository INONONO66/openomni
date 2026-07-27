CREATE TABLE _migrations (
  name TEXT PRIMARY KEY NOT NULL,
  applied_at_db_ms INTEGER NOT NULL CHECK (applied_at_db_ms >= 0)
) STRICT;

CREATE TABLE schema_meta (
  baseline_id TEXT PRIMARY KEY NOT NULL CHECK (baseline_id = 'p2-clean-v1'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
) STRICT;

CREATE TABLE ledger_event (
  ledger_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  owner_key TEXT NOT NULL,
  owner_seq INTEGER NOT NULL CHECK (owner_seq > 0),
  previous_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  event_version INTEGER NOT NULL CHECK (event_version = 1),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  event_type TEXT NOT NULL,
  canonical_payload TEXT NOT NULL CHECK (json_valid(canonical_payload)),
  canonical_provenance TEXT NOT NULL CHECK (json_valid(canonical_provenance)),
  batch_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
  batch_size INTEGER NOT NULL CHECK (batch_size BETWEEN 1 AND 64 AND batch_index < batch_size),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  principal_id TEXT NOT NULL,
  committed_at_db_ms INTEGER NOT NULL CHECK (committed_at_db_ms >= 0),
  UNIQUE (owner_key, owner_seq),
  UNIQUE (owner_key, batch_id, batch_index),
  UNIQUE (request_id, batch_index)
) STRICT;

CREATE INDEX ledger_event_owner_sequence_idx
  ON ledger_event (owner_key, owner_seq);
CREATE INDEX ledger_event_batch_idx
  ON ledger_event (owner_key, batch_id, batch_index);

CREATE TABLE ledger_head (
  owner_key TEXT PRIMARY KEY NOT NULL,
  owner_seq INTEGER NOT NULL CHECK (owner_seq > 0),
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64)
) STRICT;

CREATE TABLE ledger_request (
  request_id TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  principal_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  option_manifest_json TEXT NOT NULL CHECK (json_valid(option_manifest_json)),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  first_ledger_seq INTEGER NOT NULL CHECK (first_ledger_seq > 0),
  last_ledger_seq INTEGER NOT NULL CHECK (last_ledger_seq >= first_ledger_seq),
  UNIQUE (owner_key, batch_id)
) STRICT;

CREATE TABLE projection_checkpoint (
  projection_name TEXT PRIMARY KEY NOT NULL,
  projection_identity TEXT NOT NULL,
  ledger_seq INTEGER NOT NULL CHECK (ledger_seq >= 0),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE TABLE session_projection (
  session_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE TABLE message_projection (
  message_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX message_projection_session_idx
  ON message_projection (session_id, source_ledger_seq);

CREATE TABLE part_projection (
  part_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  part_ordinal INTEGER NOT NULL CHECK (part_ordinal >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0),
  UNIQUE (message_id, part_ordinal)
) STRICT;

CREATE INDEX part_projection_message_idx
  ON part_projection (message_id, part_ordinal);

CREATE TABLE surface_binding_projection (
  surface_key TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX surface_binding_projection_session_idx
  ON surface_binding_projection (session_id);

CREATE TABLE artifact_reference_projection (
  reference_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX artifact_reference_projection_hash_idx
  ON artifact_reference_projection (content_hash);

CREATE TABLE actor_identity_projection (
  actor_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE TABLE actor_endpoint_projection (
  endpoint_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX actor_endpoint_projection_actor_idx
  ON actor_endpoint_projection (actor_id);

CREATE TABLE blacklist_projection (
  blacklist_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE TABLE channel_grant_projection (
  grant_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE TABLE worker_grant_projection (
  grant_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  work_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX worker_grant_projection_attempt_idx
  ON worker_grant_projection (attempt_id);

CREATE TABLE schedule_projection (
  schedule_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE TABLE connector_installation_projection (
  installation_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE TABLE work_projection (
  work_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_work_id TEXT,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX work_projection_session_idx
  ON work_projection (session_id, source_ledger_seq);
CREATE INDEX work_projection_parent_idx
  ON work_projection (parent_work_id);

CREATE TABLE attempt_projection (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  work_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX attempt_projection_work_idx
  ON attempt_projection (work_id, source_ledger_seq);
CREATE INDEX attempt_projection_session_idx
  ON attempt_projection (session_id, source_ledger_seq);

CREATE TABLE wait_projection (
  wait_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  work_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX wait_projection_attempt_idx
  ON wait_projection (attempt_id, source_ledger_seq);
CREATE INDEX wait_projection_session_idx
  ON wait_projection (session_id, source_ledger_seq);

CREATE TABLE dispatch_projection (
  dispatch_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  source_owner_key TEXT NOT NULL,
  destination_owner_key TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX dispatch_projection_destination_idx
  ON dispatch_projection (destination_owner_key, source_ledger_seq);

CREATE TABLE completion_projection (
  completion_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  work_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX completion_projection_work_idx
  ON completion_projection (work_id, source_ledger_seq);

CREATE TABLE effect_projection (
  effect_id TEXT PRIMARY KEY NOT NULL,
  owner_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  source_event_id TEXT NOT NULL,
  source_owner_seq INTEGER NOT NULL CHECK (source_owner_seq > 0),
  source_ledger_seq INTEGER NOT NULL CHECK (source_ledger_seq > 0),
  source_owner_hash TEXT NOT NULL CHECK (length(source_owner_hash) = 64),
  updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
) STRICT;

CREATE INDEX effect_projection_workspace_idx
  ON effect_projection (workspace_id, source_ledger_seq);
CREATE INDEX effect_projection_attempt_idx
  ON effect_projection (attempt_id, source_ledger_seq);

CREATE TABLE artifact_blob (
  content_hash TEXT PRIMARY KEY NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  bytes BLOB NOT NULL,
  created_at_db_ms INTEGER NOT NULL CHECK (created_at_db_ms >= 0),
  CHECK (length(bytes) = byte_length)
) STRICT;
