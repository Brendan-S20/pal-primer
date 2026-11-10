-- Proof for 20261110120100: a review in HoundStack's directory is public only
-- after a moderator approves it (#630). A new review is not visible; it
-- becomes visible only after a platform admin approves it; a rejected review
-- never shows; an edit goes back to the queue; the business cannot moderate.
--
-- One copy of the proof, in tests/sql/, so the two runners cannot drift:
--   * CI's database job runs this file against the database it just built
--     from every migration (no variables, nothing to apply);
--   * tests/a-review-waits-for-a-moderator.test.ts runs the same proof with
--     :profiles and :migration set, against a local stack.
-- It ends in ROLLBACK and leaves nothing behind.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261110120100-a-review-waits-for-a-moderator.sql

\ir ../../tests/sql/a-review-waits-for-a-moderator.proof.sql
