-- Proof for 20261118050000: the /clients page reads newest-first from an index (#900).
-- One copy of the proof, in tests/sql/. Ends in ROLLBACK.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261118050000-the-clients-page-reads-newest-first-from-an-index.sql

\ir ../../tests/sql/the-clients-page-reads-newest-first-from-an-index.proof.sql
