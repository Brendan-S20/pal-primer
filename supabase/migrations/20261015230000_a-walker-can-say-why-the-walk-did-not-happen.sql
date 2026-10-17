-- Walker skip reasons (#410). A walk is not a yard visit, so the walker
-- can record that the key or code failed, that nobody was home, or that the
-- dog was not well enough to walk.
--
-- key_failed and no_one_home bill 50 by default. The walker made the trip
-- but no walk happened, and a key or code that does not work can be either
-- side's fault. dog_unwell bills nothing. An owner can change any of these
-- in skip rules.
--
-- New enum values are not used as enum literals in this file. Postgres will
-- not accept a new label in the same transaction that adds it, and a CASE
-- on the enum type is such a use. default_skip_billable_pct compares the
-- code as text instead.

ALTER TYPE public.skip_reason_code ADD VALUE IF NOT EXISTS 'key_failed';
ALTER TYPE public.skip_reason_code ADD VALUE IF NOT EXISTS 'no_one_home';
ALTER TYPE public.skip_reason_code ADD VALUE IF NOT EXISTS 'dog_unwell';

CREATE OR REPLACE FUNCTION public.default_skip_billable_pct(_code public.skip_reason_code)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE _code::text
    WHEN 'client_cancelled_late' THEN 100
    WHEN 'gate_locked'           THEN 100
    WHEN 'dog_outside'           THEN 100
    WHEN 'access_blocked'        THEN 100
    WHEN 'key_failed'            THEN 50
    WHEN 'no_one_home'           THEN 50
    WHEN 'unsafe_conditions'     THEN 50
    WHEN 'weather'               THEN 0
    WHEN 'our_fault'             THEN 0
    WHEN 'dog_unwell'            THEN 0
    WHEN 'other'                 THEN 0
    WHEN 'customer_requested'    THEN 0
    ELSE 0
  END
$$;

COMMENT ON FUNCTION public.default_skip_billable_pct(public.skip_reason_code) IS
  'Default percent of the visit price still billed when a visit is skipped for this reason. key_failed and no_one_home bill 50: the walker made the trip but no walk happened, and a key that does not work can be either side''s fault. dog_unwell bills nothing. Owners can change any of these in skip rules.';

REVOKE ALL ON FUNCTION public.default_skip_billable_pct(public.skip_reason_code) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.default_skip_billable_pct(public.skip_reason_code) TO authenticated, service_role;

DO $check$
DECLARE
  _label text;
BEGIN
  FOREACH _label IN ARRAY ARRAY['key_failed', 'no_one_home', 'dog_unwell'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'skip_reason_code'
         AND t.typnamespace = 'public'::regnamespace
         AND e.enumlabel = _label
    ) THEN
      RAISE EXCEPTION 'skip_reason_code is missing %', _label;
    END IF;
  END LOOP;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.default_skip_billable_pct(skip_reason_code)'::regprocedure)
     NOT LIKE '%key_failed%'
     OR (SELECT prosrc FROM pg_proc
          WHERE oid = 'public.default_skip_billable_pct(skip_reason_code)'::regprocedure)
        NOT LIKE '%dog_unwell%' THEN
    RAISE EXCEPTION 'default_skip_billable_pct does not know the walker reasons';
  END IF;
  -- Read from the body: the new labels cannot be passed to the function in
  -- the transaction that added them.
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.default_skip_billable_pct(skip_reason_code)'::regprocedure)
     !~ $re$'key_failed'\s+THEN 50\M$re$
     OR (SELECT prosrc FROM pg_proc
          WHERE oid = 'public.default_skip_billable_pct(skip_reason_code)'::regprocedure)
        !~ $re$'no_one_home'\s+THEN 50\M$re$ THEN
    RAISE EXCEPTION 'default_skip_billable_pct should bill key_failed and no_one_home at 50';
  END IF;
END;
$check$;
