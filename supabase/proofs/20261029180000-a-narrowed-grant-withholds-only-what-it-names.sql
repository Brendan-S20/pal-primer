-- Proof for #492: a narrowed grant withholds exactly the columns it names.
--
-- 20261015215000 replaced authenticated's table SELECT on properties with a
-- column grant that leaves out the access codes, and 20261009161500 did the
-- same for accounting_connections' tokens. Once a table is narrowed, a column
-- added later is withheld by default and the first sign is a 403 in
-- production. This asks the catalog of the database the migrations just built:
--
--   1. Every public table where authenticated has a column grant but no table
--      grant is listed below, and the columns it cannot SELECT are exactly the
--      listed ones: no more (a new column nobody granted), no fewer (a code
--      column granted back).
--   2. anon cannot SELECT any listed column.
--   3. Each listed table really is narrowed: no table-level SELECT for
--      authenticated, anon or PUBLIC.
--   4. Mutation: add a column to properties with no grant and show check 1
--      names it; put the table grant back and show check 3 names it. If
--      either does not, INCONCLUSIVE.
--
-- The list is also in tests/support/withheld-columns.ts, and
-- tests/a-new-column-is-granted-or-withheld-on-purpose.test.ts checks that the
-- two copies agree. Everything is inside one transaction that ends in
-- ROLLBACK. Run against a freshly reset local database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261029180000-a-narrowed-grant-withholds-only-what-it-names.sql

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _withheld (table_name text, column_name text, PRIMARY KEY (table_name, column_name));
INSERT INTO _withheld VALUES
-- withheld:begin
  ('properties', 'alarm_notes'),
  ('properties', 'gate_code'),
  ('properties', 'key_location'),
  ('properties', 'key_tag'),
  ('properties', 'lock_box_code'),
  ('accounting_connections', 'access_token'),
  ('accounting_connections', 'refresh_token')
-- withheld:end
;

-- Every way the catalog disagrees with _withheld, one line each.
CREATE FUNCTION pg_temp.grant_drift() RETURNS SETOF text LANGUAGE sql AS $$
  WITH tables AS (
    SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ),
  narrowed AS (
    SELECT t.* FROM tables t
     WHERE NOT has_table_privilege('authenticated', t.oid, 'SELECT')
       AND has_any_column_privilege('authenticated', t.oid, 'SELECT')
  ),
  unreadable AS (
    SELECT t.relname AS table_name, a.attname::text AS column_name
      FROM narrowed t
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE NOT has_column_privilege('authenticated', t.oid, a.attnum, 'SELECT')
  )
  SELECT format('authenticated cannot read %I.%I, which is not listed as withheld: grant it or list it',
                u.table_name, u.column_name)
    FROM unreadable u
   WHERE NOT EXISTS (SELECT 1 FROM _withheld w
                      WHERE w.table_name = u.table_name AND w.column_name = u.column_name)
  UNION ALL
  SELECT format('authenticated can read %I.%I, which is listed as withheld', w.table_name, w.column_name)
    FROM _withheld w
    JOIN tables t ON t.relname = w.table_name
   WHERE has_column_privilege('authenticated', t.oid, w.column_name, 'SELECT')
  UNION ALL
  SELECT format('anon can read %I.%I, which is listed as withheld', w.table_name, w.column_name)
    FROM _withheld w
    JOIN tables t ON t.relname = w.table_name
   WHERE has_column_privilege('anon', t.oid, w.column_name, 'SELECT')
  UNION ALL
  SELECT format('%I has a table-level SELECT for %s, which reopens every withheld column', t.relname, r.role)
    FROM (SELECT DISTINCT table_name FROM _withheld) w
    JOIN tables t ON t.relname = w.table_name
    CROSS JOIN (VALUES ('authenticated'), ('anon'), ('public')) AS r(role)
   WHERE has_table_privilege(r.role, t.oid, 'SELECT')
  UNION ALL
  SELECT format('%I is listed but does not exist, or has no column %I', w.table_name, w.column_name)
    FROM _withheld w
   WHERE NOT EXISTS (
     SELECT 1 FROM tables t
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE t.relname = w.table_name AND a.attname = w.column_name)
$$;

-- ── 1 to 3 ────────────────────────────────────────────────────────────────
DO $proof$
DECLARE
  _drift text[];
BEGIN
  SELECT array_agg(d ORDER BY d) INTO _drift FROM pg_temp.grant_drift() d;
  IF _drift IS NOT NULL THEN
    RAISE EXCEPTION E'PROOF FAILED [grant drift]:\n  %', array_to_string(_drift, E'\n  ');
  END IF;
  RAISE NOTICE 'ok: the narrowed tables withhold exactly the listed columns, from authenticated and anon';
END
$proof$;

-- ── 4. Mutation ───────────────────────────────────────────────────────────
SAVEPOINT mutation;

ALTER TABLE public.properties ADD COLUMN _proof_new_column text;
DO $mutation$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_temp.grant_drift() d WHERE d LIKE '%properties._proof_new_column%') THEN
    RAISE EXCEPTION 'INCONCLUSIVE: a properties column with no grant was not reported';
  END IF;
  RAISE NOTICE 'ok: mutation, a new properties column with no grant is reported';
END
$mutation$;
ROLLBACK TO SAVEPOINT mutation;

GRANT SELECT ON TABLE public.properties TO authenticated;
DO $mutation$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_temp.grant_drift() d
                  WHERE d LIKE 'properties has a table-level SELECT for authenticated%') THEN
    RAISE EXCEPTION 'INCONCLUSIVE: a table grant on properties was not reported';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_temp.grant_drift() d
                  WHERE d LIKE 'authenticated can read properties.gate_code%') THEN
    RAISE EXCEPTION 'INCONCLUSIVE: the reopened gate code was not reported';
  END IF;
  RAISE NOTICE 'ok: mutation, a table grant on properties is reported with the codes it reopens';
END
$mutation$;
ROLLBACK TO SAVEPOINT mutation;

-- Back to the state check 1 passed on.
DO $after$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.grant_drift()) THEN
    RAISE EXCEPTION 'PROOF FAILED [cleanup]: the savepoint did not undo the mutation';
  END IF;
END
$after$;

ROLLBACK;
