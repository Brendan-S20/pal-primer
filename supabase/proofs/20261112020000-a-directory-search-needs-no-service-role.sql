-- Proof for 20261112020000: a directory search needs no service role (#630;
-- the standalone mypets.services app). The zone "outside" filter runs inside
-- directory_search, a visitor reads exactly the public fields through the
-- RPCs and the directory_public_listings view, and the base tables, the
-- zone verdict and the org-id lookups stay shut to anon.
--
-- One copy of the proof, in tests/sql/, so the two runners cannot drift:
--   * CI's database job runs this file against the database it just built
--     from every migration (no :migration variable, nothing to apply);
--   * tests/a-directory-search-needs-no-service-role.test.ts runs the same
--     proof with :migration set, against a local stack.
-- It ends in ROLLBACK and leaves nothing behind.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261112020000-a-directory-search-needs-no-service-role.sql

\ir ../../tests/sql/a-directory-search-needs-no-service-role.proof.sql
