-- The receptionist's booking, proved against a real Postgres: the offers
-- table 20261010000000 adds, and the existing SQL the booking store calls --
-- routable_staff, portal_request_one_off, generate_visits_core -- with the
-- two new columns written the way receptionist-booking-store.server.ts
-- writes them. Run by tests/the-receptionist-books-the-visit.proof.test.ts,
-- which passes the migration's path as :migration.
--
-- One transaction, ROLLED BACK at the end with the migration inside it. Each
-- check prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- Days are relative to the org's own today (Monday to Friday), never
-- hard-coded, so this passes on any date.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

SET LOCAL request.jwt.claims = '{"role":"service_role"}';

-- ── Fixture: business A with one client, one tech; business B ──────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('b2000000-0000-4000-8000-00000000a001', 'tech-a@receptionist.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, work_days) VALUES
  ('0a200000-0000-4000-8000-00000000001a', 'Receptionist Proof A', 'America/Chicago', ARRAY[1,2,3,4,5]),
  ('0b200000-0000-4000-8000-00000000001b', 'Receptionist Proof B', 'America/Chicago', ARRAY[1,2,3,4,5]);
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name) VALUES
  ('5a200000-0000-4000-8000-0000000000a1', '0a200000-0000-4000-8000-00000000001a',
   'b2000000-0000-4000-8000-00000000a001', 'tech', 'Proof Tech A');
UPDATE public.staff SET is_field_tech = true, is_field_tech_overridden = true, active = true,
       routing_available = true
 WHERE id = '5a200000-0000-4000-8000-0000000000a1';

INSERT INTO public.clients (id, organization_id, account_type, display_name, portal_token, active, primary_phone) VALUES
  ('c2000000-0000-4000-8000-0000000000a1', '0a200000-0000-4000-8000-00000000001a', 'residential',
   'Receptionist Client A1', '22222222-aaaa-4000-8000-0000000000a1', true, '+13125550101');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('d2000000-0000-4000-8000-0000000000a1', '0a200000-0000-4000-8000-00000000001a',
   'c2000000-0000-4000-8000-0000000000a1', '1 Text St', 'Chicago', '60601');

CREATE TEMP TABLE d AS
WITH t AS (SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today),
     s AS (SELECT (t.today + g)::date AS day FROM t, generate_series(1, 20) g)
SELECT (SELECT today FROM t) AS today,
       (SELECT day FROM s WHERE extract(dow FROM day) BETWEEN 1 AND 5 ORDER BY day LIMIT 1) AS w1,
       (SELECT day FROM s WHERE extract(dow FROM day) BETWEEN 1 AND 5 ORDER BY day OFFSET 1 LIMIT 1) AS w2;

-- ── 1. offers: one per business, phone, day and address ─────────────────────
DO $$
DECLARE _d d%ROWTYPE; _n int; _err text; _target text;
  _a uuid := '0a200000-0000-4000-8000-00000000001a';
  _b uuid := '0b200000-0000-4000-8000-00000000001b';
  _c uuid := 'c2000000-0000-4000-8000-0000000000a1';
  _p uuid := 'd2000000-0000-4000-8000-0000000000a1';
BEGIN
  SELECT * INTO _d FROM d;
  INSERT INTO public.ai_receptionist_offers
    (organization_id, conversation_key, client_id, property_id, day, offered_at, expires_at)
  VALUES (_a, '13125550101', _c, _p, _d.w1, now(), now() + interval '48 hours');

  SELECT target INTO _target FROM public.ai_receptionist_offers WHERE organization_id = _a;
  IF _target IS DISTINCT FROM _p::text THEN
    RAISE EXCEPTION 'PROOF FAILED [target]: a property offer''s target is %', _target;
  END IF;

  -- The upsert the store sends (supabase-js onConflict names these four):
  -- a second offer of the same day refreshes the row rather than adding one.
  INSERT INTO public.ai_receptionist_offers
    (organization_id, conversation_key, client_id, property_id, day, offered_at, expires_at, window_start)
  VALUES (_a, '13125550101', _c, _p, _d.w1, now(), now() + interval '48 hours', '08:00')
  ON CONFLICT (organization_id, conversation_key, day, target)
  DO UPDATE SET expires_at = EXCLUDED.expires_at, window_start = EXCLUDED.window_start;
  SELECT count(*) INTO _n FROM public.ai_receptionist_offers WHERE organization_id = _a;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [upsert]: % rows for one day', _n; END IF;

  BEGIN
    INSERT INTO public.ai_receptionist_offers
      (organization_id, conversation_key, client_id, property_id, day, offered_at, expires_at)
    VALUES (_a, '13125550101', _c, _p, _d.w1, now(), now() + interval '1 hour');
  EXCEPTION WHEN unique_violation THEN _err := 'unique';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [unique]: a second offer row for one day'; END IF;

  -- The same phone texting business B is B's conversation, not A's.
  INSERT INTO public.ai_receptionist_offers
    (organization_id, conversation_key, postal_code, day, offered_at, expires_at)
  VALUES (_b, '13125550101', '60601', _d.w1, now(), now() + interval '48 hours');
  -- And a stranger's ZIP offer is keyed by the ZIP.
  SELECT target INTO _target FROM public.ai_receptionist_offers WHERE organization_id = _b;
  IF _target <> 'zip:60601' THEN RAISE EXCEPTION 'PROOF FAILED [zip target]: %', _target; END IF;

  _err := NULL;
  BEGIN
    INSERT INTO public.ai_receptionist_offers (organization_id, conversation_key, day, offered_at, expires_at)
    VALUES (_b, '13125550101', _d.w2, now(), now() + interval '1 hour');
  EXCEPTION WHEN check_violation THEN _err := 'check';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [no address]: an offer for nowhere was accepted'; END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.ai_receptionist_offers (organization_id, conversation_key, postal_code, day, offered_at, expires_at)
    VALUES (_b, 'call me maybe', '60601', _d.w2, now(), now() + interval '1 hour');
  EXCEPTION WHEN check_violation THEN _err := 'check';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [key]: a non-digit conversation key was accepted'; END IF;
  RAISE NOTICE 'ok: one offer per business, phone, day and address; upsert refreshes it';
END $$;

-- ── 2. the claim: only the first "yes" gets the row ─────────────────────────
DO $$
DECLARE _first int; _second int;
BEGIN
  WITH u AS (
    UPDATE public.ai_receptionist_offers SET claimed_at = now()
     WHERE organization_id = '0a200000-0000-4000-8000-00000000001a'
       AND claimed_at IS NULL AND outcome IS NULL RETURNING id)
  SELECT count(*) INTO _first FROM u;
  WITH u AS (
    UPDATE public.ai_receptionist_offers SET claimed_at = now()
     WHERE organization_id = '0a200000-0000-4000-8000-00000000001a'
       AND claimed_at IS NULL AND outcome IS NULL RETURNING id)
  SELECT count(*) INTO _second FROM u;
  IF _first <> 1 OR _second <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [claim]: first % second %', _first, _second;
  END IF;
  BEGIN
    UPDATE public.ai_receptionist_offers SET outcome = 'confirmed'
     WHERE organization_id = '0a200000-0000-4000-8000-00000000001a';
    RAISE EXCEPTION 'PROOF FAILED [outcome]: an unknown outcome was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: a conditional claim lets exactly one booking attempt through';
END $$;

-- ── 3. a tech on time off makes the day unstaffed (routable_staff) ──────────
DO $$
DECLARE _d d%ROWTYPE; _on uuid[]; _off uuid[];
  _a uuid := '0a200000-0000-4000-8000-00000000001a';
  _t uuid := '5a200000-0000-4000-8000-0000000000a1';
BEGIN
  SELECT * INTO _d FROM d;
  INSERT INTO public.staff_time_off (organization_id, staff_id, starts_on, ends_on)
  VALUES (_a, _t, _d.w2, _d.w2);
  _on := public.routable_staff(_a, ARRAY[_t], _d.w1);
  _off := public.routable_staff(_a, ARRAY[_t], _d.w2);
  IF coalesce(array_length(_on, 1), 0) <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [staffed]: the tech is not routable on a working day: %', _on;
  END IF;
  IF coalesce(array_length(_off, 1), 0) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [time off]: the tech is routable on a day off: %', _off;
  END IF;
  -- And another business's tech id answers nothing for business B.
  IF coalesce(array_length(public.routable_staff('0b200000-0000-4000-8000-00000000001b', ARRAY[_t], _d.w1), 1), 0) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [tenant]: A''s tech is routable for B';
  END IF;
  RAISE NOTICE 'ok: routable_staff says who can work a day, time off included';
END $$;

-- ── 4. the request and the booking, as the store makes them ─────────────────
DO $$
DECLARE _d d%ROWTYPE; _ticket uuid; _created boolean; _sub uuid; _visit uuid; _via text;
  _a uuid := '0a200000-0000-4000-8000-00000000001a';
  _c uuid := 'c2000000-0000-4000-8000-0000000000a1';
  _p uuid := 'd2000000-0000-4000-8000-0000000000a1';
BEGIN
  SELECT * INTO _d FROM d;
  SELECT ticket_id, created INTO _ticket, _created
    FROM public.portal_request_one_off('22222222-aaaa-4000-8000-0000000000a1', _p, _d.w1,
                                       'Asked by text (AI receptionist)');
  IF _ticket IS NULL OR NOT _created THEN RAISE EXCEPTION 'PROOF FAILED [request]: no ticket'; END IF;
  UPDATE public.qc_tickets SET requested_via = 'ai_receptionist' WHERE id = _ticket AND organization_id = _a;
  SELECT requested_via INTO _via FROM public.qc_tickets WHERE id = _ticket;
  IF _via IS DISTINCT FROM 'ai_receptionist' THEN RAISE EXCEPTION 'PROOF FAILED [requested_via]: %', _via; END IF;

  INSERT INTO public.subscriptions (organization_id, client_id, property_id, account_type, frequency,
                                    price_cents, billing_cadence, dog_count, started_on, ends_on,
                                    booked_via, earliest_time, latest_time)
  VALUES (_a, _c, _p, 'residential', 'one_time', 4500, 'postpaid', 1, _d.w1, _d.w1,
          'ai_receptionist', '08:00', '10:00')
  RETURNING id INTO _sub;
  PERFORM public.generate_visits_core(_a, _d.w1, _sub);
  SELECT id INTO _visit FROM public.visits WHERE subscription_id = _sub;
  IF _visit IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [visit]: the one-off generated no visit'; END IF;

  -- A second "yes" for the same day is the same request, not a second one.
  SELECT ticket_id, created INTO _ticket, _created
    FROM public.portal_request_one_off('22222222-aaaa-4000-8000-0000000000a1', _p, _d.w1, 'again');
  IF _created THEN RAISE EXCEPTION 'PROOF FAILED [twice]: a second request for one day'; END IF;

  BEGIN
    UPDATE public.subscriptions SET booked_via = 'a robot' WHERE id = _sub;
    RAISE EXCEPTION 'PROOF FAILED [booked_via]: an unknown source was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.qc_tickets SET requested_via = 'a robot' WHERE id = _ticket;
    RAISE EXCEPTION 'PROOF FAILED [requested_via]: an unknown source was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: requested through the portal''s RPC, booked through the generator, marked as by text';
END $$;

-- ── 5. nobody but the service role reads or writes the offers ───────────────
SET ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM 1 FROM public.ai_receptionist_offers;
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon read the offers'; END IF;
  RAISE NOTICE 'ok: anon cannot read the offers';
END $$;
RESET ROLE;
SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM 1 FROM public.ai_receptionist_offers;
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [authenticated]: a signed-in user read the offers'; END IF;
  RAISE NOTICE 'ok: a signed-in user cannot read the offers either';
END $$;
RESET ROLE;

\echo ALL RECEPTIONIST BOOKING PROOFS PASSED
ROLLBACK;
