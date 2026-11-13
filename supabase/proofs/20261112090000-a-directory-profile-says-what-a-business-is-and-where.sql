-- Proof for 20261112090000: a directory profile says what a business is, and
-- where (#630; mypets v2 step 5a). Tagline, highlights and business areas
-- are written by an owner only, held to their limits on every path (an
-- area's ZIPs within the profile's coverage), and reach a visitor only
-- through directory_public_listings; the base tables stay shut to anon.
--
-- One copy of the proof, in tests/sql/, so the two runners cannot drift:
--   * CI's database job runs this file against the database it just built
--     from every migration (no :migration variable, nothing to apply);
--   * tests/a-directory-profile-says-what-a-business-is-and-where.test.ts
--     runs the same proof with :migration set, against a local stack.
-- It ends in ROLLBACK and leaves nothing behind.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261112090000-a-directory-profile-says-what-a-business-is-and-where.sql

\ir ../../tests/sql/a-directory-profile-says-what-a-business-is-and-where.proof.sql
