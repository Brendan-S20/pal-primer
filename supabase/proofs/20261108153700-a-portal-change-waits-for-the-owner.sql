-- Proof for 20261108153700: a portal change waits for the owner, when the
-- owner says so (#730, D6).
--
-- One copy of the proof, in tests/sql/, so the two runners cannot drift:
--   * CI's database job runs this file against the database it just built
--     from every migration (no :migration variable, nothing to apply);
--   * tests/a-portal-change-waits-for-the-owner.test.ts runs the same proof
--     with :migration set, against a local stack.
-- It ends in ROLLBACK and leaves nothing behind.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261108153700-a-portal-change-waits-for-the-owner.sql

\ir ../../tests/sql/a-portal-change-waits-for-the-owner.proof.sql
