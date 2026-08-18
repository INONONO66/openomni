-- #498 A1: `relationship` leaves the actor vocabulary — no value-branching
-- reader ever existed, so the column carried a NOT NULL constraint the writer
-- (sqlite-actor-registry-adapter) no longer satisfies. DROP COLUMN is safe
-- here: the column is not a primary key, is not indexed (only trust_tier is),
-- and appears in no view, trigger, FK, or CHECK expression. Old `data` blobs
-- keep their `relationship` key; Actor.Identity is non-strict and strips it
-- on read, so historical rows round-trip unchanged.
ALTER TABLE actor_identity DROP COLUMN relationship;
