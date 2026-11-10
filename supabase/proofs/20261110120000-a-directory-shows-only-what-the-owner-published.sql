-- Proof for 20261110120000: a pet owner can find, compare and ask a business
-- that opted in (#630, phase 1). Anon reads only PUBLISHED profiles of live
-- businesses, only their public columns, and writes nothing; only an owner
-- of the business publishes it.
--
-- One copy of the proof, in tests/sql/, so the two runners cannot drift:
--   * CI's database job runs this file against the database it just built
--     from every migration (no :migration variable, nothing to apply);
--   * tests/a-directory-shows-only-what-the-owner-published.test.ts runs the
--     same proof with :migration set, against a local stack.
-- It ends in ROLLBACK and leaves nothing behind.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261110120000-a-directory-shows-only-what-the-owner-published.sql

\ir ../../tests/sql/a-directory-shows-only-what-the-owner-published.proof.sql
