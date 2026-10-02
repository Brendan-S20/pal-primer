-- The ZIP lookup behind "a zone you drew fills its own ZIPs", proved against a
-- real Postgres. Run by tests/a-zone-you-drew-named-no-zips.test.ts, which
-- passes the two migrations as :schema and :data.
--
-- One transaction, ROLLED BACK at the end with both migrations inside it, so a
-- shared local stack is left exactly as it was found. Each check prints
-- "ok: ..." or raises "PROOF FAILED [...]"; ON_ERROR_STOP makes the first
-- failure a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('a-zone-you-drew-named-no-zips.proof'));

\i :schema
\i :data

-- ── Two businesses, one member each ────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-00000000e1f1', 'owner@zips.proof.invalid'),
  ('a0000000-0000-4000-8000-00000000e1f2', 'other@zips.proof.invalid');
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name) VALUES
  ('0a000000-0000-4000-8000-00000000e1a1', 'Zip Proof Austin'),
  ('0a000000-0000-4000-8000-00000000e1a2', 'Zip Proof Elsewhere');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-00000000e1f1', '0a000000-0000-4000-8000-00000000e1a1', 'owner'),
  ('a0000000-0000-4000-8000-00000000e1f2', '0a000000-0000-4000-8000-00000000e1a2', 'owner');
SET LOCAL app.allow_protected_org_write = '';

-- ── The publishable key cannot call it ─────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM * FROM public.zip_centroids_in_box(
    '0a000000-0000-4000-8000-00000000e1a1', 30.2, -97.8, 30.3, -97.7, 50);
  RAISE EXCEPTION 'PROOF FAILED [anon]: the publishable key listed ZIPs';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: anon cannot execute zip_centroids_in_box';
END $$;
DO $$
BEGIN
  PERFORM 1 FROM reference.zip_centroids LIMIT 1;
  RAISE EXCEPTION 'PROOF FAILED [anon-table]: anon read the table directly';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: anon cannot read reference.zip_centroids';
END $$;
RESET ROLE;

-- ── A signed-in member of ANOTHER business cannot use this one's org ──────
SELECT set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-00000000e1f2","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM * FROM public.zip_centroids_in_box(
    '0a000000-0000-4000-8000-00000000e1a1', 30.2, -97.8, 30.3, -97.7, 50);
  RAISE EXCEPTION 'PROOF FAILED [cross-tenant]: a non-member listed ZIPs for another org';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: a non-member is refused';
END $$;
DO $$
BEGIN
  PERFORM 1 FROM reference.zip_centroids LIMIT 1;
  RAISE EXCEPTION 'PROOF FAILED [authenticated-table]: a signed-in user read the table directly';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: a signed-in user cannot read reference.zip_centroids directly';
END $$;
RESET ROLE;

-- ── A member gets the ZIPs in the box, nearest the middle first ───────────
SELECT set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-00000000e1f1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE _first text; _n integer; _outside integer;
BEGIN
  -- A box centred on downtown Austin (78701's center is 30.2706, -97.7426).
  SELECT count(*), count(*) FILTER (WHERE lat NOT BETWEEN 30.22 AND 30.32
                                       OR lng NOT BETWEEN -97.79 AND -97.69)
    INTO _n, _outside
    FROM public.zip_centroids_in_box(
      '0a000000-0000-4000-8000-00000000e1a1', 30.22, -97.79, 30.32, -97.69, 500);
  IF _n < 5 THEN
    RAISE EXCEPTION 'PROOF FAILED [member]: only % ZIP centers in central Austin', _n;
  END IF;
  IF _outside > 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [box]: % rows came back from outside the box', _outside;
  END IF;
  SELECT zip INTO _first FROM public.zip_centroids_in_box(
      '0a000000-0000-4000-8000-00000000e1a1', 30.2206, -97.7926, 30.3206, -97.6926, 500) LIMIT 1;
  IF _first <> '78701' THEN
    RAISE EXCEPTION 'PROOF FAILED [order]: a box centred on 78701 listed % first', _first;
  END IF;
  RAISE NOTICE 'ok: a member gets % ZIPs, all inside the box, nearest first', _n;
END $$;

-- The limit is honoured, and a continent is refused rather than paged.
DO $$
DECLARE _n integer;
BEGIN
  SELECT count(*) INTO _n FROM public.zip_centroids_in_box(
    '0a000000-0000-4000-8000-00000000e1a1', 29, -99, 32, -96, 7);
  IF _n <> 7 THEN
    RAISE EXCEPTION 'PROOF FAILED [limit]: asked for 7, got %', _n;
  END IF;
  BEGIN
    PERFORM * FROM public.zip_centroids_in_box(
      '0a000000-0000-4000-8000-00000000e1a1', 25, -125, 49, -67, 10);
    RAISE EXCEPTION 'PROOF FAILED [size]: a box the size of the country was answered';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  RAISE NOTICE 'ok: the limit holds and a continent-sized box is refused';
END $$;
RESET ROLE;

-- ── Loading the data twice changes nothing ────────────────────────────────
CREATE TEMP TABLE zip_count_before AS SELECT count(*) AS n FROM reference.zip_centroids;
\i :data
DO $$
DECLARE _before bigint; _after bigint;
BEGIN
  SELECT n INTO _before FROM zip_count_before;
  SELECT count(*) INTO _after FROM reference.zip_centroids;
  IF _before <> _after THEN
    RAISE EXCEPTION 'PROOF FAILED [idempotent]: % rows became % on a second load', _before, _after;
  END IF;
  RAISE NOTICE 'ok: a second load leaves % rows as they were', _after;
END $$;

ROLLBACK;

\echo ALL ZIP-FILL PROOFS PASSED
