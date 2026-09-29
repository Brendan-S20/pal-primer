-- The extra-cleanup request's rules, proved in a real Postgres. Run by
-- tests/a-double-tap-books-one-extra-cleanup.test.ts, which passes the
-- migration's path as :migration.
--
-- One transaction, ROLLED BACK at the end, the migration included. Each check
-- prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- Days are chosen relative to the org's own today and its work_days
-- (Monday to Friday here), never hard-coded, so this passes on any date.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

BEGIN;

\i :migration

SET LOCAL request.jwt.claims = '{"role":"service_role"}';

-- ── Fixture: two tenants, two clients in A, one in B ────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('b1000000-0000-4000-8000-00000000a001', 'owner-a@oneoff.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, work_days) VALUES
  ('0a000000-0000-4000-8000-00000000001a', 'One-off Proof A', 'America/Chicago', ARRAY[1,2,3,4,5]),
  ('0b000000-0000-4000-8000-00000000001b', 'One-off Proof B', 'America/Chicago', ARRAY[0,1,2,3,4,5,6]);
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('b1000000-0000-4000-8000-00000000a001', '0a000000-0000-4000-8000-00000000001a', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.clients (id, organization_id, account_type, display_name, portal_token, active) VALUES
  ('c1000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000001a', 'residential', 'One-off Client A1',
   '11111111-aaaa-4000-8000-0000000000a1', true),
  ('c1000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000001a', 'residential', 'One-off Client A2',
   '11111111-aaaa-4000-8000-0000000000a2', true),
  ('c1000000-0000-4000-8000-0000000000a3', '0a000000-0000-4000-8000-00000000001a', 'residential', 'One-off Client A3 (inactive)',
   '11111111-aaaa-4000-8000-0000000000a3', false),
  ('c1000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000001b', 'residential', 'One-off Client B1',
   '11111111-aaaa-4000-8000-0000000000b1', true);
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, archived_at) VALUES
  ('d1000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000001a', 'c1000000-0000-4000-8000-0000000000a1', '1 Home St',  'Springfield', '60614', NULL),
  ('d1000000-0000-4000-8000-0000000000a9', '0a000000-0000-4000-8000-00000000001a', 'c1000000-0000-4000-8000-0000000000a1', '9 Old St',   'Springfield', '60614', now()),
  ('d1000000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000001a', 'c1000000-0000-4000-8000-0000000000a2', '2 Next Door', 'Springfield', '60614', NULL),
  ('d1000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-00000000001b', 'c1000000-0000-4000-8000-0000000000b1', '1 Other Town', 'Shelbyville', '60615', NULL);
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on) VALUES
  ('e1000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000001a', 'c1000000-0000-4000-8000-0000000000a1',
   'd1000000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2400, 1, current_date);

-- Days, on org A's calendar. w1/w2/w3: the first three weekdays after today.
-- sat: the first Saturday after today. far: the first weekday past 30 days.
CREATE TEMP TABLE d AS
WITH t AS (SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today),
     s AS (SELECT t.today, (t.today + g)::date AS day FROM t, generate_series(1, 45) g)
SELECT (SELECT today FROM t) AS today,
       (SELECT day FROM s WHERE extract(dow FROM day) BETWEEN 1 AND 5 ORDER BY day LIMIT 1) AS w1,
       (SELECT day FROM s WHERE extract(dow FROM day) BETWEEN 1 AND 5 ORDER BY day OFFSET 1 LIMIT 1) AS w2,
       (SELECT day FROM s WHERE extract(dow FROM day) BETWEEN 1 AND 5 ORDER BY day OFFSET 2 LIMIT 1) AS w3,
       (SELECT day FROM s WHERE extract(dow FROM day) BETWEEN 1 AND 5 ORDER BY day OFFSET 3 LIMIT 1) AS w4,
       (SELECT day FROM s WHERE extract(dow FROM day) = 6 ORDER BY day LIMIT 1) AS sat,
       (SELECT day FROM s WHERE extract(dow FROM day) BETWEEN 1 AND 5 AND day > today + 30 ORDER BY day LIMIT 1) AS far,
       (SELECT day FROM s WHERE extract(dow FROM day) BETWEEN 1 AND 5 AND day <= today + 30 ORDER BY day DESC LIMIT 1) AS last_ok;

-- A blackout on w3, and an existing visit at A1's home on w4.
INSERT INTO public.blackout_dates (organization_id, blackout_on)
SELECT '0a000000-0000-4000-8000-00000000001a', w3 FROM d;
INSERT INTO public.visits (organization_id, subscription_id, client_id, property_id, scheduled_on)
SELECT '0a000000-0000-4000-8000-00000000001a', 'e1000000-0000-4000-8000-0000000000a1',
       'c1000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1', w4 FROM d;

-- Try one request; return the error code, or 'accepted'.
CREATE FUNCTION pg_temp.try_one_off(_tok uuid, _prop uuid, _on date) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.portal_request_one_off(_tok, _prop, _on, 'note');
  RETURN 'accepted';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $$;

-- ── The refusals ────────────────────────────────────────────────────────────
DO $$
DECLARE _d d%ROWTYPE; _r text;
  _a1 uuid := '11111111-aaaa-4000-8000-0000000000a1';
  _home uuid := 'd1000000-0000-4000-8000-0000000000a1';
BEGIN
  SELECT * INTO _d FROM d;

  _r := pg_temp.try_one_off(_a1, _home, _d.sat);
  IF _r <> 'not_a_working_day' THEN
    RAISE EXCEPTION 'PROOF FAILED [not a working day]: a Saturday on a Monday-to-Friday org: %', _r;
  END IF;

  _r := pg_temp.try_one_off(_a1, _home, _d.today - 1);
  IF _r <> 'date_in_past' THEN RAISE EXCEPTION 'PROOF FAILED [past]: yesterday: %', _r; END IF;
  _r := pg_temp.try_one_off(_a1, _home, NULL);
  IF _r <> 'date_in_past' THEN RAISE EXCEPTION 'PROOF FAILED [no day]: %', _r; END IF;
  _r := pg_temp.try_one_off(_a1, _home, _d.today);
  IF _r <> 'date_too_soon' THEN RAISE EXCEPTION 'PROOF FAILED [today]: the org''s today: %', _r; END IF;

  _r := pg_temp.try_one_off(_a1, _home, _d.far);
  IF _r <> 'date_too_far' THEN RAISE EXCEPTION 'PROOF FAILED [beyond 30 days]: %: %', _d.far, _r; END IF;
  _r := pg_temp.try_one_off(_a1, _home, (_d.today + 31));
  IF _r NOT IN ('date_too_far') THEN RAISE EXCEPTION 'PROOF FAILED [day 31]: %', _r; END IF;

  -- Another client's property, in the same org and in another org, and the
  -- client's own ARCHIVED one: all the same refusal.
  _r := pg_temp.try_one_off(_a1, 'd1000000-0000-4000-8000-0000000000a2', _d.w1);
  IF _r <> 'property_not_found' THEN
    RAISE EXCEPTION 'PROOF FAILED [another client''s property]: a neighbour''s address: %', _r;
  END IF;
  _r := pg_temp.try_one_off(_a1, 'd1000000-0000-4000-8000-0000000000b1', _d.w1);
  IF _r <> 'property_not_found' THEN
    RAISE EXCEPTION 'PROOF FAILED [another tenant''s property]: %', _r;
  END IF;
  _r := pg_temp.try_one_off(_a1, 'd1000000-0000-4000-8000-0000000000a9', _d.w1);
  IF _r <> 'property_not_found' THEN
    RAISE EXCEPTION 'PROOF FAILED [archived property]: %', _r;
  END IF;

  _r := pg_temp.try_one_off(_a1, _home, _d.w3);
  IF _r <> 'blackout_day' THEN RAISE EXCEPTION 'PROOF FAILED [blackout]: %', _r; END IF;
  _r := pg_temp.try_one_off(_a1, _home, _d.w4);
  IF _r <> 'already_scheduled' THEN RAISE EXCEPTION 'PROOF FAILED [already a visit]: %', _r; END IF;

  _r := pg_temp.try_one_off('11111111-aaaa-4000-8000-0000000000a3', _home, _d.w1);
  IF _r <> 'invalid_token' THEN RAISE EXCEPTION 'PROOF FAILED [inactive client]: %', _r; END IF;
  _r := pg_temp.try_one_off(gen_random_uuid(), _home, _d.w1);
  IF _r <> 'invalid_token' THEN RAISE EXCEPTION 'PROOF FAILED [unknown token]: %', _r; END IF;

  IF (SELECT count(*) FROM public.qc_tickets WHERE category = 'one_off_request') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [refusals wrote]: a refused request left a row';
  END IF;
  RAISE NOTICE 'ok: refused on a non-working day, in the past, today, beyond 30 days, a blackout, a day already booked, an unknown or inactive client, and anybody else''s property; nothing written';
END $$;

-- ── The edges that must be ACCEPTED ─────────────────────────────────────────
DO $$
DECLARE _d d%ROWTYPE; _r text;
BEGIN
  SELECT * INTO _d FROM d;
  _r := pg_temp.try_one_off('11111111-aaaa-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1', _d.last_ok);
  IF _r <> 'accepted' THEN RAISE EXCEPTION 'PROOF FAILED [day 30]: the last working day inside 30 days (%): %', _d.last_ok, _r; END IF;
  RAISE NOTICE 'ok: the last working day inside the 30 is accepted';
END $$;

-- ── A double tap is one request ─────────────────────────────────────────────
DO $$
DECLARE _d d%ROWTYPE; _t1 uuid; _c1 boolean; _t2 uuid; _c2 boolean; _n int;
BEGIN
  SELECT * INTO _d FROM d;
  SELECT ticket_id, created INTO _t1, _c1 FROM public.portal_request_one_off(
    '11111111-aaaa-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1', _d.w1, '  Party on Saturday  ');
  SELECT ticket_id, created INTO _t2, _c2 FROM public.portal_request_one_off(
    '11111111-aaaa-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1', _d.w1, 'second tap');
  IF _t1 IS NULL OR _c1 IS NOT TRUE THEN RAISE EXCEPTION 'PROOF FAILED [first tap]: % %', _t1, _c1; END IF;
  IF _t2 IS DISTINCT FROM _t1 OR _c2 IS NOT FALSE THEN
    RAISE EXCEPTION 'PROOF FAILED [double tap]: first % (created %), second % (created %)', _t1, _c1, _t2, _c2;
  END IF;
  SELECT count(*) INTO _n FROM public.qc_tickets
   WHERE category = 'one_off_request' AND requested_on = _d.w1;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [double tap]: % rows', _n; END IF;
  IF (SELECT message FROM public.qc_tickets WHERE id = _t1) <> 'Party on Saturday' THEN
    RAISE EXCEPTION 'PROOF FAILED [note]: the first tap''s note was not kept, trimmed';
  END IF;
  IF (SELECT property_id FROM public.qc_tickets WHERE id = _t1) <> 'd1000000-0000-4000-8000-0000000000a1'
     OR (SELECT organization_id FROM public.qc_tickets WHERE id = _t1) <> '0a000000-0000-4000-8000-00000000001a' THEN
    RAISE EXCEPTION 'PROOF FAILED [tenancy]: the request is not the client''s, at the property, in the org';
  END IF;

  -- The partial unique index holds even for a writer that skips the lookup,
  -- which is what two concurrent taps are.
  BEGIN
    INSERT INTO public.qc_tickets (organization_id, client_id, property_id, category, requested_on)
    VALUES ('0a000000-0000-4000-8000-00000000001a', 'c1000000-0000-4000-8000-0000000000a1',
            'd1000000-0000-4000-8000-0000000000a1', 'one_off_request', _d.w1);
    RAISE EXCEPTION 'PROOF FAILED [index]: a second open request for the same property and day was stored';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: a double tap returns the first request, created once, and the index refuses a second';
END $$;

-- ── Booked, the second tap still finds the request, not a refusal ───────────
-- What auto-accept does after booking: the one_time subscription, the visit
-- from generate_visits_core (as the service role, with nobody signed in), the
-- ticket resolved with the visit linked.
DO $$
DECLARE _d d%ROWTYPE; _t uuid; _t2 uuid; _c boolean; _sub uuid := gen_random_uuid(); _v uuid; _n int;
BEGIN
  SELECT * INTO _d FROM d;
  SELECT id INTO _t FROM public.qc_tickets WHERE category = 'one_off_request' AND requested_on = _d.w1;

  INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                    price_cents, dog_count, started_on, ends_on)
  VALUES (_sub, '0a000000-0000-4000-8000-00000000001a', 'c1000000-0000-4000-8000-0000000000a1',
          'd1000000-0000-4000-8000-0000000000a1', 'residential', 'one_time', 4500, 1, _d.w1, _d.w1);
  PERFORM public.generate_visits_core('0a000000-0000-4000-8000-00000000001a', _d.w1, _sub);
  SELECT count(*), min(id::text)::uuid INTO _n, _v FROM public.visits WHERE subscription_id = _sub;
  IF _n <> 1 OR (SELECT scheduled_on FROM public.visits WHERE id = _v) <> _d.w1 THEN
    RAISE EXCEPTION 'PROOF FAILED [service generation]: % visits for the one-off, not one on %', _n, _d.w1;
  END IF;
  UPDATE public.qc_tickets SET booked_visit_id = _v, status = 'resolved', resolved_at = now(),
         resolution_note = 'Booked.' WHERE id = _t;

  -- The tap that arrives after auto-accept already booked the first one. A
  -- refusal here ("you already have a visit that day") is the customer being
  -- told off for their own double tap.
  BEGIN
    SELECT ticket_id, created INTO _t2, _c FROM public.portal_request_one_off(
      '11111111-aaaa-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1', _d.w1, 'third tap');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'PROOF FAILED [after booking]: a tap after the booking was refused: %', SQLERRM;
  END;
  IF _t2 IS DISTINCT FROM _t OR _c IS NOT FALSE THEN
    RAISE EXCEPTION 'PROOF FAILED [after booking]: a tap after the booking got % (created %), not the booked request', _t2, _c;
  END IF;
  SELECT count(*) INTO _n FROM public.visits
   WHERE property_id = 'd1000000-0000-4000-8000-0000000000a1' AND scheduled_on = _d.w1;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [one visit]: % visits on the day', _n; END IF;

  -- What the portal lists for it.
  IF NOT EXISTS (
    SELECT 1 FROM public.portal_list_my_requests('11111111-aaaa-4000-8000-0000000000a1') r
     WHERE r.ticket_id = _t AND r.category = 'one_off_request'
       AND r.requested_on = _d.w1 AND r.booked_on = _d.w1 AND r.status = 'resolved'
  ) THEN
    RAISE EXCEPTION 'PROOF FAILED [portal list]: the booked request does not list with its day and booking';
  END IF;
  RAISE NOTICE 'ok: the service role generates the one visit, and a tap after booking returns the booked request, not a second visit';
END $$;

-- ── Declined, the customer may ask again ────────────────────────────────────
DO $$
DECLARE _d d%ROWTYPE; _t uuid; _t2 uuid; _c boolean;
BEGIN
  SELECT * INTO _d FROM d;
  SELECT ticket_id INTO _t FROM public.portal_request_one_off(
    '11111111-aaaa-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1', _d.w2, NULL);
  UPDATE public.qc_tickets SET status = 'resolved', resolved_at = now(),
         resolution_note = 'We could not fit that day in.' WHERE id = _t;
  SELECT ticket_id, created INTO _t2, _c FROM public.portal_request_one_off(
    '11111111-aaaa-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1', _d.w2, 'please?');
  IF _t2 = _t OR _c IS NOT TRUE THEN
    RAISE EXCEPTION 'PROOF FAILED [declined]: asking again after a decline returned the declined request';
  END IF;
  IF (SELECT message FROM public.qc_tickets WHERE id = _t) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [blank note]: an empty note was stored as text';
  END IF;
  RAISE NOTICE 'ok: a declined request does not block asking again';
END $$;

-- ── Who can call it ─────────────────────────────────────────────────────────
SET ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.portal_request_one_off('11111111-aaaa-4000-8000-0000000000a1',
      'd1000000-0000-4000-8000-0000000000a1', (SELECT w1 FROM d), 'x');
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon called portal_request_one_off'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.portal_list_my_requests('11111111-aaaa-4000-8000-0000000000a1');
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon called portal_list_my_requests'; END IF;
  RAISE NOTICE 'ok: anon can call neither';
END $$;
RESET ROLE;
SET LOCAL request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-00000000a001","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.portal_request_one_off('11111111-aaaa-4000-8000-0000000000a1',
      'd1000000-0000-4000-8000-0000000000a1', (SELECT w1 FROM d), 'x');
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [authenticated]: a signed-in owner called portal_request_one_off directly';
  END IF;
  RAISE NOTICE 'ok: a signed-in owner cannot call it either; the portal reaches it only as the service role';
END $$;
RESET ROLE;

\echo ALL ONE-OFF REQUEST PROOFS PASSED
ROLLBACK;
