-- Extend the sole alarm owner without rewriting history or source bytes.
-- Refuse malformed historical watch specs instead of launching guessed commands.
CREATE TABLE _alarm_watch_guard (invalid INTEGER NOT NULL CHECK (invalid = 0));
INSERT INTO _alarm_watch_guard
SELECT COUNT(*) FROM alarm
WHERE kind = 'watch' AND status = 'armed'
  AND (spec IS NULL OR json_type(spec, '$.watch') IS NOT 'object');
DROP TABLE _alarm_watch_guard;
ALTER TABLE alarm ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0);
ALTER TABLE alarm ADD COLUMN fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0);
ALTER TABLE alarm ADD COLUMN last_batch TEXT;
ALTER TABLE alarm ADD COLUMN notifications INTEGER NOT NULL DEFAULT 0 CHECK (notifications >= 0);
