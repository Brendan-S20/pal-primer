-- Proof for 20261118030000: an invited technician is not blocked by a membership that is over (#982).
-- One copy of the proof, in tests/sql/. Ends in ROLLBACK.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261118030000-an-invite-is-not-blocked-by-a-membership-that-is-over.sql

\ir ../../tests/sql/an-invite-is-not-blocked-by-a-membership-that-is-over.proof.sql
