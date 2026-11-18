-- Proof for 20261118040000: a business that drops pet waste no longer ends days at a dump (#980).
-- One copy of the proof, in tests/sql/. Ends in ROLLBACK.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261118040000-a-business-that-drops-pet-waste-no-longer-ends-days-at-a-dump.sql

\ir ../../tests/sql/a-business-that-drops-pet-waste-no-longer-ends-days-at-a-dump.proof.sql
