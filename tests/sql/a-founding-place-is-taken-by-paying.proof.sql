-- claim_founding_place, proved in a real Postgres. Run by
-- tests/a-founding-place-is-taken-by-paying.test.ts, which passes the
-- migration's path as :migration and FOUNDING_SPOTS as :spots.
--
-- One transaction, ROLLED BACK at the end, the migration included. Each check
-- prints "ok: ..." or raises "PROOF FAILED [...]".

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- Whatever a database already holds, this proof counts from an empty table.
DELETE FROM public.founding_accounts;

-- ── Fixture: spots + 2 organizations ────────────────────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
CREATE TEMP TABLE fx ON COMMIT DROP AS
SELECT g AS n, gen_random_uuid() AS id FROM generate_series(1, :spots + 2) g;
INSERT INTO public.organizations (id, name)
SELECT id, 'Founding Proof ' || n FROM fx;
SET LOCAL app.allow_protected_org_write = '';

CREATE TEMP TABLE spots ON COMMIT DROP AS SELECT :spots::integer AS n;

-- ── Places 1..spots, in order, then none ────────────────────────────────────
DO $$
DECLARE _spots integer := (SELECT n FROM spots);
        r record;
        c record;
BEGIN
  FOR r IN SELECT * FROM fx WHERE n <= _spots ORDER BY n LOOP
    SELECT * INTO c FROM public.claim_founding_place(r.id, 'sub_proof_' || r.n, _spots);
    IF c.place IS DISTINCT FROM r.n OR NOT c.newly_claimed OR c.places_taken <> r.n THEN
      RAISE EXCEPTION 'PROOF FAILED [order]: claim % returned place %, newly %, taken %', r.n, c.place, c.newly_claimed, c.places_taken;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: the first % paid accounts take places 1..% in order', _spots, _spots;
END $$;

DO $$
DECLARE _spots integer := (SELECT n FROM spots);
        _late uuid := (SELECT id FROM fx WHERE n = _spots + 1);
        c record;
BEGIN
  SELECT * INTO c FROM public.claim_founding_place(_late, 'sub_proof_late', _spots);
  IF c.place IS NOT NULL OR NOT c.newly_claimed OR c.places_taken <> _spots THEN
    RAISE EXCEPTION 'PROOF FAILED [over]: the payment after the last place got place %, taken %', c.place, c.places_taken;
  END IF;
  IF (SELECT count(*) FROM public.founding_accounts WHERE place IS NOT NULL) <> _spots
     OR NOT EXISTS (SELECT 1 FROM public.founding_accounts WHERE organization_id = _late AND place IS NULL) THEN
    RAISE EXCEPTION 'PROOF FAILED [over]: the late payer is not recorded as over the limit';
  END IF;
  RAISE NOTICE 'ok: a payment after place % gets none, and is recorded (place NULL)', _spots;
END $$;

-- ── Once per account ────────────────────────────────────────────────────────
DO $$
DECLARE _spots integer := (SELECT n FROM spots);
        _first uuid := (SELECT id FROM fx WHERE n = 1);
        _late uuid := (SELECT id FROM fx WHERE n = _spots + 1);
        c record;
BEGIN
  SELECT * INTO c FROM public.claim_founding_place(_first, 'sub_proof_again', _spots);
  IF c.place <> 1 OR c.newly_claimed THEN
    RAISE EXCEPTION 'PROOF FAILED [once]: a second sighting of account 1 returned place %, newly %', c.place, c.newly_claimed;
  END IF;
  -- A late payer stays late, even if a place were somehow free again.
  DELETE FROM public.founding_accounts WHERE place = (SELECT n FROM spots);
  SELECT * INTO c FROM public.claim_founding_place(_late, 'sub_proof_late', _spots);
  IF c.place IS NOT NULL OR c.newly_claimed THEN
    RAISE EXCEPTION 'PROOF FAILED [once]: the late payer was promoted to place %', c.place;
  END IF;
  IF (SELECT count(*) FROM public.founding_accounts) <> _spots THEN
    RAISE EXCEPTION 'PROOF FAILED [once]: % rows after repeat claims', (SELECT count(*) FROM public.founding_accounts);
  END IF;
  RAISE NOTICE 'ok: each account is answered once; a repeat returns the same answer';
END $$;

-- ── A place cannot be held twice, even by a writer that skips the function ──
DO $$
DECLARE _spare uuid := (SELECT id FROM fx WHERE n = (SELECT n FROM spots) + 2);
BEGIN
  BEGIN
    INSERT INTO public.founding_accounts (organization_id, stripe_subscription_id, place) VALUES (_spare, 'sub_x', 1);
    RAISE EXCEPTION 'PROOF FAILED [unique]: place 1 was taken twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: place is unique';
END $$;

-- ── Service role only ───────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.claim_founding_place(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.claim_founding_place(uuid, text, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.claim_founding_place(uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: claim_founding_place is not service-role only';
  END IF;
  IF has_table_privilege('authenticated', 'public.founding_accounts', 'INSERT') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: an owner could write a founding place';
  END IF;
  RAISE NOTICE 'ok: only the service role can take a place';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL FOUNDING PLACE PROOFS PASSED'; END $$;

ROLLBACK;
