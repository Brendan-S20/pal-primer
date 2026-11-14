-- Proof for 20261112100000: a directory listing says which services book
-- online (#630; mypets v2 step 7). The owner's directory switch is off by
-- default and written by an owner only; directory_public_listings says each
-- listed service's EFFECTIVE booking mode, which is request_only unless the
-- switch, public signup and Stripe charges are all on and the service's own
-- mode can be sold; the hand-off lookup is the service role's and reads the
-- view; the base tables stay shut to anon.
--
-- One copy of the proof, in tests/sql/, so the two runners cannot drift:
--   * CI's database job runs this file against the database it just built
--     from every migration (no :migration variable, nothing to apply);
--   * tests/a-directory-listing-says-which-services-book-online.test.ts
--     runs the same proof with :migration set, against a local stack.
-- It ends in ROLLBACK and leaves nothing behind.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261112100000-a-directory-listing-says-which-services-book-online.sql

\ir ../../tests/sql/a-directory-listing-says-which-services-book-online.proof.sql
