-- One decline counts once, proved against a real Postgres rather than read off
-- the migration's text. Run by tests/one-decline-counts-once.test.ts, which
-- passes the migration's path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included. Each group prints "ok: ..." only when every check
-- in it passed, or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the
-- first failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Org A pauses after 3 declines (the default), org B after 5.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name) VALUES
  ('0a700000-0000-4000-8000-0000000000aa', 'Decline Proof A'),
  ('0b700000-0000-4000-8000-0000000000bb', 'Decline Proof B');
UPDATE public.organizations SET dunning_pause_after_failures = 5
 WHERE id = '0b700000-0000-4000-8000-0000000000bb';
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c7000000-0000-4000-8000-0000000000a1', '0a700000-0000-4000-8000-0000000000aa', 'residential', 'Decline Proof A1'),
  ('c7000000-0000-4000-8000-0000000000a2', '0a700000-0000-4000-8000-0000000000aa', 'residential', 'Decline Proof A2'),
  ('c7000000-0000-4000-8000-0000000000a3', '0a700000-0000-4000-8000-0000000000aa', 'residential', 'Decline Proof A3'),
  ('c7000000-0000-4000-8000-0000000000b1', '0b700000-0000-4000-8000-0000000000bb', 'residential', 'Decline Proof B1');

-- ── 1. One decline delivered three times counts once ───────────────────────
DO $$
DECLARE _r record; _i int;
BEGIN
  FOR _i IN 1..3 LOOP
    SELECT * INTO _r FROM public.count_autopay_decline(
      'c7000000-0000-4000-8000-0000000000a1', 'pi_proof_once', 'Your card was declined.');
    IF _r.counted IS DISTINCT FROM (_i = 1) THEN
      RAISE EXCEPTION 'PROOF FAILED [redelivery]: delivery % counted=%', _i, _r.counted;
    END IF;
    IF _r.failure_count <> 1 THEN
      RAISE EXCEPTION 'PROOF FAILED [redelivery]: after delivery % the count is %', _i, _r.failure_count;
    END IF;
  END LOOP;
  IF (SELECT autopay_failure_count FROM public.clients WHERE id = 'c7000000-0000-4000-8000-0000000000a1') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [redelivery]: the stored count is not 1';
  END IF;
  RAISE NOTICE 'ok: one decline delivered three times counts once';
END $$;

-- ── 2. The webhook and the nightly run reporting the same PaymentIntent ────
-- Whichever reports it first counts it; the other is told it was counted.
DO $$
DECLARE _first record; _second record;
BEGIN
  SELECT * INTO _first FROM public.count_autopay_decline(
    'c7000000-0000-4000-8000-0000000000a2', 'pi_proof_both_paths', 'nightly saw it');
  SELECT * INTO _second FROM public.count_autopay_decline(
    'c7000000-0000-4000-8000-0000000000a2', 'pi_proof_both_paths', 'webhook saw it');
  IF NOT _first.counted OR _second.counted OR _second.failure_count <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [two paths]: % then %', _first, _second;
  END IF;
  -- The duplicate changes nothing, not even the error text or the attempt time
  -- the nightly retry ladder waits on.
  IF (SELECT autopay_last_error FROM public.clients WHERE id = 'c7000000-0000-4000-8000-0000000000a2')
     IS DISTINCT FROM 'nightly saw it' THEN
    RAISE EXCEPTION 'PROOF FAILED [two paths]: the duplicate rewrote the client';
  END IF;
  RAISE NOTICE 'ok: the webhook and the nightly run reporting one PaymentIntent count it once';
END $$;

-- ── 3. Two distinct declines count twice ───────────────────────────────────
DO $$
DECLARE _r record;
BEGIN
  SELECT * INTO _r FROM public.count_autopay_decline(
    'c7000000-0000-4000-8000-0000000000a1', 'pi_proof_second', 'declined again');
  IF NOT _r.counted OR _r.failure_count <> 2 OR _r.paused THEN
    RAISE EXCEPTION 'PROOF FAILED [distinct]: %', _r;
  END IF;
  RAISE NOTICE 'ok: two distinct declines count twice';
END $$;

-- ── 4. Autopay pauses exactly at N distinct declines ───────────────────────
DO $$
DECLARE _r record; _i int;
BEGIN
  -- Org A, N = 3: client A1 is at 2 after groups 1 and 3, unpaused.
  SELECT * INTO _r FROM public.count_autopay_decline(
    'c7000000-0000-4000-8000-0000000000a1', 'pi_proof_third', 'third');
  IF NOT _r.counted OR _r.failure_count <> 3 OR NOT _r.paused OR _r.pause_after <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [pause at 3]: %', _r;
  END IF;
  -- Org B, N = 5: one decline reported twice each time is still five declines
  -- to the pause, not three.
  FOR _i IN 1..5 LOOP
    PERFORM public.count_autopay_decline('c7000000-0000-4000-8000-0000000000b1', 'pi_proof_b' || _i, 'x');
    SELECT * INTO _r FROM public.count_autopay_decline(
      'c7000000-0000-4000-8000-0000000000b1', 'pi_proof_b' || _i, 'x');
    IF _r.failure_count <> _i OR _r.paused IS DISTINCT FROM (_i >= 5) THEN
      RAISE EXCEPTION 'PROOF FAILED [pause at 5]: after % declines %', _i, _r;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: autopay pauses exactly at the configured number of distinct declines';
END $$;

-- ── 5. A success resets, and an old decline redelivered after it does not count
DO $$
DECLARE _r record;
BEGIN
  -- What the webhook's payment_intent.succeeded branch writes.
  UPDATE public.clients
     SET autopay_failure_count = 0, autopay_paused = false, autopay_last_error = NULL
   WHERE id = 'c7000000-0000-4000-8000-0000000000a1';

  SELECT * INTO _r FROM public.count_autopay_decline(
    'c7000000-0000-4000-8000-0000000000a1', 'pi_proof_once', 'a late redelivery');
  IF _r.counted OR _r.failure_count <> 0 OR _r.paused THEN
    RAISE EXCEPTION 'PROOF FAILED [reset]: an old decline restarted the ladder: %', _r;
  END IF;
  SELECT * INTO _r FROM public.count_autopay_decline(
    'c7000000-0000-4000-8000-0000000000a1', 'pi_proof_after_reset', 'a new decline');
  IF NOT _r.counted OR _r.failure_count <> 1 OR _r.paused THEN
    RAISE EXCEPTION 'PROOF FAILED [reset]: a new decline after the reset: %', _r;
  END IF;
  RAISE NOTICE 'ok: a success resets the ladder, and an old decline redelivered after it does not count';
END $$;

-- ── 6. A failure that never reached Stripe counts each time ────────────────
DO $$
DECLARE _r record;
BEGIN
  PERFORM public.count_autopay_decline('c7000000-0000-4000-8000-0000000000a3', NULL, 'night one');
  SELECT * INTO _r FROM public.count_autopay_decline('c7000000-0000-4000-8000-0000000000a3', NULL, 'night two');
  IF NOT _r.counted OR _r.failure_count <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [no PaymentIntent]: %', _r;
  END IF;
  IF cardinality((SELECT autopay_counted_decline_pis FROM public.clients
                   WHERE id = 'c7000000-0000-4000-8000-0000000000a3')) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [no PaymentIntent]: a NULL was recorded as a PaymentIntent';
  END IF;
  RAISE NOTICE 'ok: a nightly failure with no PaymentIntent counts once per attempt';
END $$;

-- ── 7. A decline never lifts a pause ───────────────────────────────────────
DO $$
DECLARE _r record;
BEGIN
  -- Client A2 is at 1; pretend the office's threshold was lower when it paused.
  UPDATE public.clients SET autopay_paused = true WHERE id = 'c7000000-0000-4000-8000-0000000000a2';
  SELECT * INTO _r FROM public.count_autopay_decline(
    'c7000000-0000-4000-8000-0000000000a2', 'pi_proof_paused', 'x');
  IF NOT _r.counted OR NOT _r.paused THEN
    RAISE EXCEPTION 'PROOF FAILED [no unpause]: %', _r;
  END IF;
  RAISE NOTICE 'ok: a decline never lifts a pause';
END $$;

-- ── 8. The record of what was counted stays bounded ────────────────────────
DO $$
DECLARE _pis text[]; _i int;
BEGIN
  FOR _i IN 1..60 LOOP
    PERFORM public.count_autopay_decline('c7000000-0000-4000-8000-0000000000a3', 'pi_proof_many_' || _i, 'x');
  END LOOP;
  SELECT autopay_counted_decline_pis INTO _pis FROM public.clients
   WHERE id = 'c7000000-0000-4000-8000-0000000000a3';
  IF cardinality(_pis) <> 50 OR _pis[50] <> 'pi_proof_many_60' OR _pis[1] <> 'pi_proof_many_11' THEN
    RAISE EXCEPTION 'PROOF FAILED [bounded]: % entries, first %, last %', cardinality(_pis), _pis[1], _pis[50];
  END IF;
  RAISE NOTICE 'ok: the counted PaymentIntents are the last fifty';
END $$;

-- ── 9. Only the service role can move a ladder ─────────────────────────────
DO $$
DECLARE _fn regprocedure := 'public.count_autopay_decline(uuid, text, text)'::regprocedure;
BEGIN
  IF has_function_privilege('anon', _fn, 'EXECUTE')
     OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: a browser key can count declines';
  END IF;
  IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: the service role cannot count declines';
  END IF;
  RAISE NOTICE 'ok: only the service role can count a decline';
END $$;

-- ── 10. An unknown client is refused, not silently ignored ────────────────
DO $$
BEGIN
  BEGIN
    PERFORM public.count_autopay_decline('c7000000-0000-4000-8000-0000000000ff', 'pi_nobody', 'x');
    RAISE EXCEPTION 'PROOF FAILED [unknown client]: no error';
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;
  RAISE NOTICE 'ok: an unknown client is refused';
END $$;

ROLLBACK;
\echo ALL DECLINE-COUNT PROOFS PASSED
