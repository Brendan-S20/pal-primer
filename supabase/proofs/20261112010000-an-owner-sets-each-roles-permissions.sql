-- Proof for 20261112010000: an owner sets each role's permissions; today's
-- rules are the defaults (#863). An empty overrides table is the matrix main
-- shipped; a row the owner writes changes has_permission and so RLS and the
-- office RPCs, for that business and role only; the floors hold whatever is
-- stored (the owner-only permissions, the owner's own row, a technician's
-- gate code, the rank rule); only the owner writes; every change is logged;
-- Brendan's dispatcher defaults (cancel yes, complete yes, prepaid no) hold.
--
-- One copy of the proof, in tests/sql/, so the two runners cannot drift:
--   * CI's database job runs this file against the database it just built
--     from every migration (no variables, nothing to apply);
--   * tests/an-owner-sets-each-roles-permissions.test.ts runs the same proof
--     with :migration set, against a local stack.
-- It ends in ROLLBACK and leaves nothing behind.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261112010000-an-owner-sets-each-roles-permissions.sql

\ir ../../tests/sql/an-owner-sets-each-roles-permissions.proof.sql
