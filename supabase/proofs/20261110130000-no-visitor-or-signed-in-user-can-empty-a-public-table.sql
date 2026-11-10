-- Proof for 20261110130000: no visitor or signed-in user can empty a public
-- table (#842).
--
-- Supabase's default privileges give anon and authenticated TRUNCATE, TRIGGER
-- and REFERENCES on every table postgres creates in public, and RLS does not
-- protect TRUNCATE. 20261109030541 closed this on the portal_change_* tables;
-- 20261110130000 closes it on the other 106 that a production census found.
-- This asks the catalog of the database the migrations just built:
--
--   1. No public base table lets anon or authenticated TRUNCATE, TRIGGER or
--      REFERENCES it (directly, through PUBLIC, or through a role it belongs
--      to). Every table, not a list, so a table added later with the default
--      grants is named here.
--   2. The check actually looked: it saw the tables #842 is about, including
--      every directory_* and portal_* table the migrations create. A catalog
--      query that matched nothing would otherwise pass check 1.
--   3. Mutations, each rolled back: grant TRUNCATE on directory_profiles to
--      authenticated, REFERENCES on portal_sessions to anon, and TRIGGER on
--      clients to PUBLIC (which anon and authenticated inherit), and show
--      check 1 names each one. If it does not, INCONCLUSIVE.
--   4. The next table: postgres's default privileges in public no longer
--      hand out the three, and a table created now, as postgres, arrives
--      without them. Default SELECT is not this file's business and is not
--      asserted either way.
--   5. Mutation: put TRUNCATE back into postgres's defaults and show both
--      the stored-default check and a newly created table name it.
--
-- One transaction, ending in ROLLBACK. Run against a freshly reset database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261110130000-no-visitor-or-signed-in-user-can-empty-a-public-table.sql

\set ON_ERROR_STOP on
BEGIN;

-- Every TRUNCATE, TRIGGER or REFERENCES anon or authenticated holds on a
-- public base table, one line each.
CREATE FUNCTION pg_temp.client_role_table_grant_drift() RETURNS SETOF text LANGUAGE sql AS $$
  SELECT format('%s holds %s on public.%I', r.role, p.priv, c.relname)
    FROM pg_class c
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
    CROSS JOIN (VALUES ('TRUNCATE'), ('TRIGGER'), ('REFERENCES')) AS p(priv)
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p')
     AND has_table_privilege(r.role, c.oid, p.priv)
$$;

-- Every TRUNCATE, TRIGGER or REFERENCES postgres's default privileges hand
-- anon or authenticated on new tables in public (or in every schema).
CREATE FUNCTION pg_temp.client_role_default_grant_drift() RETURNS SETOF text LANGUAGE sql AS $$
  SELECT format('postgres default %s on new public tables for %s', x.privilege_type, x.grantee::regrole)
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) x
   WHERE d.defaclrole = 'postgres'::regrole
     AND d.defaclobjtype = 'r'
     AND d.defaclnamespace IN (0, 'public'::regnamespace)
     AND x.grantee IN ('anon'::regrole, 'authenticated'::regrole)
     AND x.privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')
$$;

-- ── 1 ─────────────────────────────────────────────────────────────────────
DO $proof$
DECLARE
  _drift text[];
BEGIN
  SELECT array_agg(d ORDER BY d) INTO _drift FROM pg_temp.client_role_table_grant_drift() d;
  IF _drift IS NOT NULL THEN
    RAISE EXCEPTION E'PROOF FAILED [public table grants]:\n  %', array_to_string(_drift, E'\n  ');
  END IF;
  RAISE NOTICE 'ok: no public table grants TRUNCATE, TRIGGER or REFERENCES to anon or authenticated';
END
$proof$;

-- ── 2 ─────────────────────────────────────────────────────────────────────
DO $proof$
DECLARE
  _tables int;
  _missing text[];
  _dir_portal int;
BEGIN
  SELECT count(*) INTO _tables
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p');

  SELECT array_agg(t ORDER BY t) INTO _missing
    FROM unnest(ARRAY[
      'directory_profiles', 'directory_profile_services', 'directory_reviews',
      'portal_sessions', 'portal_otps', 'portal_code_attempts',
      'portal_change_rules', 'portal_change_requests', 'portal_change_fee_charges',
      'portal_change_fee_events', 'clients', 'organizations', 'time_entries'
    ]) AS t
   WHERE to_regclass('public.' || t) IS NULL;
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'INCONCLUSIVE: check 1 cannot have covered tables that do not exist: %',
      array_to_string(_missing, ', ');
  END IF;

  SELECT count(*) INTO _dir_portal
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND (c.relname LIKE 'directory\_%' OR c.relname LIKE 'portal\_%');

  RAISE NOTICE 'ok: check 1 covered % public base tables, % of them directory_* or portal_*',
    _tables, _dir_portal;
END
$proof$;

-- ── 3. Mutations ──────────────────────────────────────────────────────────
SAVEPOINT mutation;

GRANT TRUNCATE ON TABLE public.directory_profiles TO authenticated;
GRANT REFERENCES ON TABLE public.portal_sessions TO anon;
GRANT TRIGGER ON TABLE public.clients TO PUBLIC;
DO $mutation$
DECLARE
  _want text;
BEGIN
  FOREACH _want IN ARRAY ARRAY[
    'authenticated holds TRUNCATE on public.directory_profiles',
    'anon holds REFERENCES on public.portal_sessions',
    'anon holds TRIGGER on public.clients',
    'authenticated holds TRIGGER on public.clients'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_temp.client_role_table_grant_drift() d WHERE d = _want) THEN
      RAISE EXCEPTION 'INCONCLUSIVE: a grant put back was not reported: %', _want;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: mutation, each privilege granted back (directly and through PUBLIC) is reported';
END
$mutation$;
ROLLBACK TO SAVEPOINT mutation;

-- ── 4. The next table ─────────────────────────────────────────────────────
DO $proof$
DECLARE
  _drift text[];
BEGIN
  SELECT array_agg(d ORDER BY d) INTO _drift FROM pg_temp.client_role_default_grant_drift() d;
  IF _drift IS NOT NULL THEN
    RAISE EXCEPTION E'PROOF FAILED [default privileges]:\n  %', array_to_string(_drift, E'\n  ');
  END IF;
  RAISE NOTICE 'ok: postgres default privileges in public grant no TRUNCATE, TRIGGER or REFERENCES to anon or authenticated';
END
$proof$;

SAVEPOINT next_table;
SET LOCAL ROLE postgres;
CREATE TABLE public._proof_next_table_842 (id int);
RESET ROLE;
DO $proof$
DECLARE
  _drift text[];
BEGIN
  SELECT array_agg(d ORDER BY d) INTO _drift
    FROM pg_temp.client_role_table_grant_drift() d
   WHERE d LIKE '%public._proof_next_table_842';
  IF _drift IS NOT NULL THEN
    RAISE EXCEPTION E'PROOF FAILED [a new table]:\n  %', array_to_string(_drift, E'\n  ');
  END IF;
  RAISE NOTICE 'ok: a table postgres creates in public now arrives without TRUNCATE, TRIGGER or REFERENCES for anon or authenticated';
END
$proof$;
ROLLBACK TO SAVEPOINT next_table;

-- ── 5. Mutation ───────────────────────────────────────────────────────────
SAVEPOINT mutation;

SET LOCAL ROLE postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT TRUNCATE ON TABLES TO authenticated;
CREATE TABLE public._proof_next_table_842 (id int);
RESET ROLE;
DO $mutation$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_temp.client_role_default_grant_drift() d
                  WHERE d = 'postgres default TRUNCATE on new public tables for authenticated') THEN
    RAISE EXCEPTION 'INCONCLUSIVE: TRUNCATE put back into postgres default privileges was not reported';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_temp.client_role_table_grant_drift() d
                  WHERE d = 'authenticated holds TRUNCATE on public._proof_next_table_842') THEN
    RAISE EXCEPTION 'INCONCLUSIVE: a new table created under that default was not reported';
  END IF;
  RAISE NOTICE 'ok: mutation, a default put back is reported, and so is the table it creates';
END
$mutation$;
ROLLBACK TO SAVEPOINT mutation;

ROLLBACK;
