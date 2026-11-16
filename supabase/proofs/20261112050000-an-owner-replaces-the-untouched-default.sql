-- Proof for 20261112050000 (#883): adding a pet-waste service replaces only
-- the untouched, unreferenced starter. Saved or referenced services survive.
--
-- One copy of the proof for both runners:
--   * CI's database job executes this wrapper after replaying all migrations,
--     without :migration;
--   * the local Vitest runner sets :migration and applies it transactionally.
-- The shared proof ends in ROLLBACK and leaves nothing behind.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261112050000-an-owner-replaces-the-untouched-default.sql

\ir ../../tests/sql/an-owner-replaces-the-untouched-default.proof.sql
