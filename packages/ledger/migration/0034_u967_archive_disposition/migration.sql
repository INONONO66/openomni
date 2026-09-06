-- Nonempty targets require the explicit verified archive command's preparation
-- inside this migration's BEGIN IMMEDIATE. Ordinary boot cannot authorize rows.
CREATE TABLE _u967_guard (blocked INTEGER NOT NULL CHECK (blocked = 0));
INSERT INTO _u967_guard SELECT count(*) FROM bus_event;
INSERT INTO _u967_guard SELECT count(*) FROM wait WHERE owner_kind IS NOT 'session';
DROP TABLE bus_event;
DROP TABLE _u967_guard;
