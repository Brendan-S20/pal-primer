-- Proof for 20261118010000: a directory profile may publish a contact (#969).
-- One copy of the proof, in tests/sql/. Ends in ROLLBACK.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261118010000-a-directory-profile-can-publish-a-contact.sql

\ir ../../tests/sql/a-directory-profile-can-publish-a-contact.proof.sql
