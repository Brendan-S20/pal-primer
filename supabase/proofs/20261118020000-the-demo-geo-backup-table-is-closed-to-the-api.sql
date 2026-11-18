-- Proof for 20261118020000: the demo-geo backup table is closed to the API (#977).
-- One copy of the proof, in tests/sql/. Ends in ROLLBACK.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261118020000-the-demo-geo-backup-table-is-closed-to-the-api.sql

\ir ../../tests/sql/the-demo-geo-backup-table-is-closed-to-the-api.proof.sql
