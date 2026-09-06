CREATE TABLE _message_cutover_archive_required (row_count INTEGER NOT NULL CHECK (row_count = 0));
INSERT INTO _message_cutover_archive_required SELECT COUNT(*) FROM delegation;
INSERT INTO _message_cutover_archive_required SELECT COUNT(*) FROM worker_run_state;
INSERT INTO _message_cutover_archive_required SELECT COUNT(*) FROM worker_grant;
DROP TABLE delegation;
DROP TABLE worker_grant;
DROP TABLE worker_run_state;
DROP TABLE _message_cutover_archive_required;
