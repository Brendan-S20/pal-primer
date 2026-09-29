-- The live-tracking privacy rules, proved against a real Postgres rather than
-- read off the migration's text. Run by
-- tests/only-the-assigned-tech-shares-and-only-the-office-watches.test.ts,
-- which passes the migration's path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included, so this can be pointed at a shared local stack
-- without leaving a table, a column or a row behind. Each check prints
-- "ok: ..." or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the first
-- failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Org A: an owner, Sam (tech, assigned) and Priya (tech, not assigned).
-- Org B: Omar (tech). Both orgs have tracking ON, so every refusal below is
-- the rule refusing, not the switch.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a1000000-0000-4000-8000-00000000a001', 'owner-a@track.proof.invalid'),
  ('a1000000-0000-4000-8000-00000000a002', 'sam-a@track.proof.invalid'),
  ('a1000000-0000-4000-8000-00000000a003', 'priya-a@track.proof.invalid'),
  ('b1000000-0000-4000-8000-00000000b001', 'omar-b@track.proof.invalid');

INSERT INTO public.organizations (id, name, timezone, live_tracking_enabled) VALUES
  ('0a100000-0000-4000-8000-0000000000aa', 'Track Proof A', 'America/Chicago', true),
  ('0b100000-0000-4000-8000-0000000000bb', 'Track Proof B', 'America/Chicago', true);
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a1000000-0000-4000-8000-00000000a001', '0a100000-0000-4000-8000-0000000000aa', 'owner'),
  ('a1000000-0000-4000-8000-00000000a002', '0a100000-0000-4000-8000-0000000000aa', 'tech'),
  ('a1000000-0000-4000-8000-00000000a003', '0a100000-0000-4000-8000-0000000000aa', 'tech'),
  ('b1000000-0000-4000-8000-00000000b001', '0b100000-0000-4000-8000-0000000000bb', 'tech');

INSERT INTO public.staff (id, organization_id, user_id, role, display_name) VALUES
  ('5a000000-0000-4000-8000-000000000001', '0a100000-0000-4000-8000-0000000000aa',
   'a1000000-0000-4000-8000-00000000a001', 'owner', 'Olivia Owner'),
  ('5a000000-0000-4000-8000-000000000002', '0a100000-0000-4000-8000-0000000000aa',
   'a1000000-0000-4000-8000-00000000a002', 'tech', '  Sam   Rivera-Castellanos '),
  ('5a000000-0000-4000-8000-000000000003', '0a100000-0000-4000-8000-0000000000aa',
   'a1000000-0000-4000-8000-00000000a003', 'tech', 'Priya Patel'),
  ('5b000000-0000-4000-8000-000000000001', '0b100000-0000-4000-8000-0000000000bb',
   'b1000000-0000-4000-8000-00000000b001', 'tech', 'Omar Okafor');

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa', 'residential', 'Proof Client A'),
  ('c1000000-0000-4000-8000-0000000000b1', '0b100000-0000-4000-8000-0000000000bb', 'residential', 'Proof Client B');

INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude) VALUES
  ('e1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa',
   'c1000000-0000-4000-8000-0000000000a1', '412 Elm St', 'Chicago', '60614', 41.921734, -87.648321),
  ('e1000000-0000-4000-8000-0000000000b1', '0b100000-0000-4000-8000-0000000000bb',
   'c1000000-0000-4000-8000-0000000000b1', '9 Oak Ave', 'Chicago', '60657', 41.940112, -87.653377);

INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count) VALUES
  ('d1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa',
   'c1000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2400, 2),
  ('d1000000-0000-4000-8000-0000000000b1', '0b100000-0000-4000-8000-0000000000bb',
   'c1000000-0000-4000-8000-0000000000b1', 'e1000000-0000-4000-8000-0000000000b1', 'residential', 'weekly', 2400, 2);

-- A1: announced 5 minutes ago, Sam's.     A2: Sam's, never announced.
-- A3: announced 3 hours ago, Sam's.       B1: announced, Omar's, in org B.
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, assigned_staff_id,
                           scheduled_on, status, on_my_way_sent_at, tracking_token, eta_start, eta_end) VALUES
  ('f1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa', 'd1000000-0000-4000-8000-0000000000a1',
   'c1000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-000000000002',
   current_date, 'scheduled', now() - interval '5 minutes', '7a000000-0000-4000-8000-0000000000a1',
   now() + interval '10 minutes', now() + interval '40 minutes'),
  ('f1000000-0000-4000-8000-0000000000a2', '0a100000-0000-4000-8000-0000000000aa', 'd1000000-0000-4000-8000-0000000000a1',
   'c1000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-000000000002',
   current_date + 1, 'scheduled', NULL, '7a000000-0000-4000-8000-0000000000a2', NULL, NULL),
  ('f1000000-0000-4000-8000-0000000000a3', '0a100000-0000-4000-8000-0000000000aa', 'd1000000-0000-4000-8000-0000000000a1',
   'c1000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-0000000000a1', '5a000000-0000-4000-8000-000000000002',
   current_date + 2, 'scheduled', now() - interval '3 hours', '7a000000-0000-4000-8000-0000000000a3', NULL, NULL),
  ('f1000000-0000-4000-8000-0000000000b1', '0b100000-0000-4000-8000-0000000000bb', 'd1000000-0000-4000-8000-0000000000b1',
   'c1000000-0000-4000-8000-0000000000b1', 'e1000000-0000-4000-8000-0000000000b1', '5b000000-0000-4000-8000-000000000001',
   current_date, 'scheduled', now() - interval '5 minutes', '7b000000-0000-4000-8000-0000000000b1', NULL, NULL);

-- ── Sam, the assigned tech: writes inside the window, and only there ────────
SELECT set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _err text; _n int; _at timestamptz;
BEGIN
  INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng, accuracy, recorded_at)
  VALUES ('f1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa',
          '5a000000-0000-4000-8000-000000000002', 41.9001234, -87.6505678, 12, '2000-01-01');
  -- The upsert the server function sends: latest position only.
  INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng, accuracy)
  VALUES ('f1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa',
          '5a000000-0000-4000-8000-000000000002', 41.9104567, -87.6498765, 8)
  ON CONFLICT (visit_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy = EXCLUDED.accuracy;
  SELECT count(*), max(recorded_at) INTO _n, _at FROM public.visit_live_locations;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [upsert]: % rows for one visit, expected the latest only', _n; END IF;
  IF _at < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'PROOF FAILED [clock]: recorded_at is %, the phone''s clock, not the database''s', _at;
  END IF;

  -- Not announced yet: before "on my way", nothing.
  BEGIN
    INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
    VALUES ('f1000000-0000-4000-8000-0000000000a2', '0a100000-0000-4000-8000-0000000000aa',
            '5a000000-0000-4000-8000-000000000002', 41.9, -87.65);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [before on-my-way]: Sam shared before the message'; END IF;

  -- Two hours after the message: nothing.
  _err := NULL;
  BEGIN
    INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
    VALUES ('f1000000-0000-4000-8000-0000000000a3', '0a100000-0000-4000-8000-0000000000aa',
            '5a000000-0000-4000-8000-000000000002', 41.9, -87.65);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [2 hours]: Sam shared 3 hours after the message'; END IF;

  -- Omar's visit in org B, under Omar's staff id: the staff row must be the caller's.
  _err := NULL;
  BEGIN
    INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
    VALUES ('f1000000-0000-4000-8000-0000000000b1', '0b100000-0000-4000-8000-0000000000bb',
            '5b000000-0000-4000-8000-000000000001', 41.9, -87.65);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [other org]: Sam wrote a position onto org B''s visit'; END IF;
  RAISE NOTICE 'ok: the assigned tech writes one latest row in the window, stamped by the database, and nowhere else';
END $$;
RESET ROLE;

-- ── Priya, same org, not assigned; Omar, other org ──────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-00000000a003","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _err text; _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.visit_live_locations;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [colleague reads]: Priya sees % of Sam''s positions', _n; END IF;
  BEGIN
    INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
    VALUES ('f1000000-0000-4000-8000-0000000000a2', '0a100000-0000-4000-8000-0000000000aa',
            '5a000000-0000-4000-8000-000000000003', 41.9, -87.65);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [not assigned]: Priya wrote to a visit that is not hers'; END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
    VALUES ('f1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa',
            '5a000000-0000-4000-8000-000000000002', 41.8, -87.60)
    ON CONFLICT (visit_id) DO UPDATE SET lat = EXCLUDED.lat;
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [impersonation]: Priya wrote Sam''s position under Sam''s staff id'; END IF;
  UPDATE public.visit_live_locations SET lat = 0 WHERE visit_id = 'f1000000-0000-4000-8000-0000000000a1';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [colleague update]: Priya moved Sam'; END IF;
  DELETE FROM public.visit_live_locations;
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [colleague delete]: Priya deleted Sam''s position'; END IF;
  IF public.may_share_live_location('f1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa',
                                    '5a000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'PROOF FAILED [helper]: may_share_live_location said yes to Priya about Sam''s ids';
  END IF;
  RAISE NOTICE 'ok: a tech in the same org can neither read, write, move nor delete the assigned tech''s position';
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-00000000b001","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _err text; _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.visit_live_locations;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [other org reads]: Omar sees % of org A''s positions', _n; END IF;
  BEGIN
    INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
    VALUES ('f1000000-0000-4000-8000-0000000000a1', '0b100000-0000-4000-8000-0000000000bb',
            '5b000000-0000-4000-8000-000000000001', 41.9, -87.65)
    ON CONFLICT (visit_id) DO UPDATE SET lat = EXCLUDED.lat;
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [other org writes]: Omar wrote onto org A''s visit'; END IF;
  -- His own visit, in his own window, is his to share.
  INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
  VALUES ('f1000000-0000-4000-8000-0000000000b1', '0b100000-0000-4000-8000-0000000000bb',
          '5b000000-0000-4000-8000-000000000001', 41.93, -87.65);
  RAISE NOTICE 'ok: a tech in another org can neither read nor write org A''s positions';
END $$;
RESET ROLE;

-- ── The office reads its own org, and only its own ──────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _n int; _err text;
BEGIN
  SELECT count(*) INTO _n FROM public.visit_live_locations;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [office reads]: the owner of A sees % rows, expected Sam''s 1', _n; END IF;
  -- The office watches; it does not put a tech anywhere.
  BEGIN
    INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
    VALUES ('f1000000-0000-4000-8000-0000000000a2', '0a100000-0000-4000-8000-0000000000aa',
            '5a000000-0000-4000-8000-000000000002', 41.9, -87.65);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [office writes]: the owner wrote a position for Sam'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.public_visit_tracking('7a000000-0000-4000-8000-0000000000a1');
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [authenticated]: a signed-in user can call public_visit_tracking'; END IF;
  RAISE NOTICE 'ok: the office reads its own org''s position, not another''s, and cannot forge one';
END $$;
RESET ROLE;

-- ── anon: no table, no function ─────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true);
SET ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM 1 FROM public.visit_live_locations LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can SELECT visit_live_locations'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.public_visit_tracking('7a000000-0000-4000-8000-0000000000a1');
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can call public_visit_tracking'; END IF;
  RAISE NOTICE 'ok: anon can neither read the table nor call the public function';
END $$;
RESET ROLE;

-- ── What the customer's link shows (as service_role would) ──────────────────
DO $$
DECLARE _d jsonb;
BEGIN
  IF public.public_visit_tracking(gen_random_uuid()) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [unknown token]: returned %', public.public_visit_tracking(gen_random_uuid());
  END IF;
  IF public.public_visit_tracking(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [null token]: returned something';
  END IF;
  -- A2 has a token but its message never went: indistinguishable from a typo.
  IF public.public_visit_tracking('7a000000-0000-4000-8000-0000000000a2') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [never sent]: a link for an unannounced visit answered';
  END IF;

  _d := public.public_visit_tracking('7a000000-0000-4000-8000-0000000000a1');
  IF _d->>'status' <> 'en_route' OR _d->>'business_name' <> 'Track Proof A'
     OR _d->>'tech_first_name' <> 'Sam' OR (_d->>'sharing')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'PROOF FAILED [en route]: %', _d;
  END IF;
  -- Rounded to 3 places inside the database: 41.9104567 -> 41.910.
  IF (_d->>'tech_lat')::numeric <> 41.910 OR (_d->>'tech_lng')::numeric <> -87.650
     OR (_d->>'home_lat')::numeric <> 41.922 OR (_d->>'home_lng')::numeric <> -87.648 THEN
    RAISE EXCEPTION 'PROOF FAILED [rounding]: %', _d;
  END IF;
  IF _d::text LIKE '%41.9104567%' OR _d::text LIKE '%41.921734%' OR _d::text LIKE '%Rivera%' THEN
    RAISE EXCEPTION 'PROOF FAILED [leak]: an exact position or a surname left the database: %', _d;
  END IF;
  IF _d ? 'id' OR _d ? 'organization_id' OR _d ? 'client_id' OR _d ? 'accuracy' OR _d ? 'staff_id' THEN
    RAISE EXCEPTION 'PROOF FAILED [leak]: internal fields in %', _d;
  END IF;

  -- Three hours after the message: ended, and nothing locational.
  _d := public.public_visit_tracking('7a000000-0000-4000-8000-0000000000a3');
  IF _d->>'status' <> 'ended' OR _d ? 'tech_lat' OR _d ? 'home_lat' OR _d ? 'eta_start' THEN
    RAISE EXCEPTION 'PROOF FAILED [expired]: %', _d;
  END IF;
  RAISE NOTICE 'ok: the link refuses unknown and unsent tokens, and shows a rounded position en route';
END $$;

-- ── Stop: the row goes, and the link stops showing the tech ─────────────────
SELECT set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);
SET ROLE authenticated;
UPDATE public.visits SET live_tracking_stopped_at = now() WHERE id = 'f1000000-0000-4000-8000-0000000000a1';
DO $$
DECLARE _err text; _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.visit_live_locations WHERE visit_id = 'f1000000-0000-4000-8000-0000000000a1';
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [stop]: the position outlived Stop'; END IF;
  BEGIN
    INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
    VALUES ('f1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa',
            '5a000000-0000-4000-8000-000000000002', 41.91, -87.65);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [stop]: Sam could share again after pressing Stop'; END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
DECLARE _d jsonb;
BEGIN
  _d := public.public_visit_tracking('7a000000-0000-4000-8000-0000000000a1');
  IF _d->>'status' <> 'en_route' OR (_d->>'sharing')::boolean IS NOT FALSE
     OR (_d->'tech_lat') IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [stopped link]: %', _d;
  END IF;
  RAISE NOTICE 'ok: Stop deletes the position, refuses the next one, and the link shows no tech';
END $$;

-- A newer "on my way" (the button, pressed again) reopens it.
UPDATE public.visits SET live_tracking_stopped_at = now() - interval '1 minute', on_my_way_sent_at = now()
 WHERE id = 'f1000000-0000-4000-8000-0000000000a1';
SELECT set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);
SET ROLE authenticated;
INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
VALUES ('f1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa',
        '5a000000-0000-4000-8000-000000000002', 41.9155, -87.6491);

-- ── Arrival: the tech starts the visit ──────────────────────────────────────
UPDATE public.visits SET status = 'in_progress', started_at = now() WHERE id = 'f1000000-0000-4000-8000-0000000000a1';
DO $$
DECLARE _err text; _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.visit_live_locations WHERE visit_id = 'f1000000-0000-4000-8000-0000000000a1';
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [start]: the position outlived the start of the visit'; END IF;
  BEGIN
    INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
    VALUES ('f1000000-0000-4000-8000-0000000000a1', '0a100000-0000-4000-8000-0000000000aa',
            '5a000000-0000-4000-8000-000000000002', 41.91, -87.65);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [start]: Sam could share after starting the visit'; END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);
DO $$
DECLARE _d jsonb;
BEGIN
  _d := public.public_visit_tracking('7a000000-0000-4000-8000-0000000000a1');
  IF _d->>'status' <> 'arrived' OR _d->>'tech_first_name' <> 'Sam'
     OR _d ? 'tech_lat' OR _d ? 'tech_lng' OR _d ? 'home_lat' OR _d ? 'home_lng' OR _d ? 'eta_start' THEN
    RAISE EXCEPTION 'PROOF FAILED [arrived]: %', _d;
  END IF;
  UPDATE public.visits SET status = 'completed', completed_at = now() WHERE id = 'f1000000-0000-4000-8000-0000000000a1';
  _d := public.public_visit_tracking('7a000000-0000-4000-8000-0000000000a1');
  IF _d->>'status' <> 'done' OR _d ? 'tech_lat' OR _d ? 'home_lat' THEN
    RAISE EXCEPTION 'PROOF FAILED [done]: %', _d;
  END IF;
  RAISE NOTICE 'ok: once the visit starts the link says arrived and shows nobody''s location, and after it nothing';
END $$;

-- ── Turning tracking off forgets the org; the nightly prune forgets the rest ─
DO $$
DECLARE _n int; _d jsonb;
BEGIN
  -- A row whose window closed by the clock (A3, 3 hours) that nobody deleted,
  -- beside B1's live one.
  INSERT INTO public.visit_live_locations (visit_id, organization_id, staff_id, lat, lng)
  VALUES ('f1000000-0000-4000-8000-0000000000a3', '0a100000-0000-4000-8000-0000000000aa',
          '5a000000-0000-4000-8000-000000000002', 41.9, -87.65);
  _n := public.prune_visit_live_locations();
  IF _n <> 1 OR EXISTS (SELECT 1 FROM public.visit_live_locations WHERE visit_id = 'f1000000-0000-4000-8000-0000000000a3') THEN
    RAISE EXCEPTION 'PROOF FAILED [prune]: pruned %, the expired row is still there or the live one went', _n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.visit_live_locations WHERE visit_id = 'f1000000-0000-4000-8000-0000000000b1') THEN
    RAISE EXCEPTION 'PROOF FAILED [prune]: the live row in an open window was deleted';
  END IF;

  UPDATE public.organizations SET live_tracking_enabled = false WHERE id = '0b100000-0000-4000-8000-0000000000bb';
  IF EXISTS (SELECT 1 FROM public.visit_live_locations WHERE organization_id = '0b100000-0000-4000-8000-0000000000bb') THEN
    RAISE EXCEPTION 'PROOF FAILED [switch off]: org B''s positions outlived turning tracking off';
  END IF;
  _d := public.public_visit_tracking('7b000000-0000-4000-8000-0000000000b1');
  IF (_d->>'sharing')::boolean IS NOT FALSE OR (_d->'tech_lat') IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [switch off]: %', _d;
  END IF;
  RAISE NOTICE 'ok: turning tracking off and the nightly prune both leave nothing behind';
END $$;

-- ── New organizations start with it off ─────────────────────────────────────
DO $$
BEGIN
  SET LOCAL app.allow_protected_org_write = '1';
  INSERT INTO public.organizations (id, name) VALUES ('0c100000-0000-4000-8000-0000000000cc', 'Track Proof C');
  IF (SELECT live_tracking_enabled FROM public.organizations WHERE id = '0c100000-0000-4000-8000-0000000000cc') THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: a new organization starts with tracking on';
  END IF;
  RAISE NOTICE 'ok: a new organization starts with live tracking off';
END $$;

\echo ALL LIVE TRACKING PROOFS PASSED
ROLLBACK;
