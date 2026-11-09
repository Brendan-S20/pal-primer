-- Proof for 20261109030541: signed-in users cannot empty the portal change
-- tables.
--
-- 20261108153700 revoked INSERT, UPDATE and DELETE from authenticated on
-- portal_change_rules, portal_change_requests and portal_change_fee_charges,
-- but the default grants also gave it TRUNCATE, REFERENCES and TRIGGER, and
-- RLS does not protect TRUNCATE. This asks the catalog of the database the
-- migrations just built:
--
--   1. On each of the three tables, authenticated holds SELECT and nothing
--      else (directly, through PUBLIC, or through a role it belongs to).
--   2. Mutation: grant TRUNCATE back and show check 1 names it. If it does
--      not, INCONCLUSIVE.
--
-- One transaction, ending in ROLLBACK. Run against a freshly reset database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261109030541-signed-in-users-cannot-empty-the-portal-change-tables.sql

\set ON_ERROR_STOP on
BEGIN;

-- Every privilege authenticated holds on the three tables other than SELECT,
-- and a missing SELECT, one line each.
CREATE FUNCTION pg_temp.portal_change_grant_drift() RETURNS SETOF text LANGUAGE sql AS $$
  WITH t(name) AS (VALUES
    ('public.portal_change_rules'),
    ('public.portal_change_requests'),
    ('public.portal_change_fee_charges')
  ),
  p(priv) AS (VALUES
    ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
  )
  SELECT format('authenticated holds %s on %s; it should hold SELECT only', p.priv, t.name)
    FROM t CROSS JOIN p
   WHERE has_table_privilege('authenticated', t.name, p.priv)
  UNION ALL
  SELECT format('authenticated cannot SELECT %s, which RLS is meant to scope', t.name)
    FROM t
   WHERE NOT has_table_privilege('authenticated', t.name, 'SELECT')
$$;

-- ── 1 ─────────────────────────────────────────────────────────────────────
DO $proof$
DECLARE
  _drift text[];
BEGIN
  SELECT array_agg(d ORDER BY d) INTO _drift FROM pg_temp.portal_change_grant_drift() d;
  IF _drift IS NOT NULL THEN
    RAISE EXCEPTION E'PROOF FAILED [portal change grants]:\n  %', array_to_string(_drift, E'\n  ');
  END IF;
  RAISE NOTICE 'ok: authenticated holds only SELECT on the three portal change tables';
END
$proof$;

-- ── 2. Mutation ───────────────────────────────────────────────────────────
SAVEPOINT mutation;

GRANT TRUNCATE ON TABLE public.portal_change_requests TO authenticated;
DO $mutation$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_temp.portal_change_grant_drift() d
                  WHERE d LIKE '%TRUNCATE on public.portal_change_requests%') THEN
    RAISE EXCEPTION 'INCONCLUSIVE: TRUNCATE granted back to authenticated was not reported';
  END IF;
  RAISE NOTICE 'ok: mutation, TRUNCATE granted back to authenticated is reported';
END
$mutation$;
ROLLBACK TO SAVEPOINT mutation;

ROLLBACK;
