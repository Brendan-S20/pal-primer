-- The calendar feed's access rules, proved in a real Postgres. Run by
-- tests/a-calendar-link-opens-one-persons-visits-and-nothing-else.test.ts,
-- which passes the migration's path as :migration.
--
-- One transaction, ROLLED BACK at the end, the migration included. Each check
-- prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- Tokens are plain strings here; the database only ever sees their SHA-256,
-- computed the way calendar-feed.server.ts computes it.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture: two tenants ────────────────────────────────────────────────────
-- A: an owner, two technicians and a dispatcher. B: one technician.
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-00000000a001', 'owner-a@feed.proof.invalid'),
  ('f0000000-0000-4000-8000-00000000a002', 'tech-a@feed.proof.invalid'),
  ('f0000000-0000-4000-8000-00000000a003', 'dispatch-a@feed.proof.invalid'),
  ('f0000000-0000-4000-8000-00000000a004', 'tech2-a@feed.proof.invalid'),
  ('f0000000-0000-4000-8000-00000000b001', 'tech-b@feed.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000000fa', 'Feed Proof A', 'America/Chicago'),
  ('0b000000-0000-4000-8000-0000000000fb', 'Feed Proof B', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-00000000a001', '0a000000-0000-4000-8000-0000000000fa', 'owner'),
  ('f0000000-0000-4000-8000-00000000a002', '0a000000-0000-4000-8000-0000000000fa', 'tech'),
  ('f0000000-0000-4000-8000-00000000a003', '0a000000-0000-4000-8000-0000000000fa', 'dispatcher'),
  ('f0000000-0000-4000-8000-00000000a004', '0a000000-0000-4000-8000-0000000000fa', 'tech'),
  ('f0000000-0000-4000-8000-00000000b001', '0b000000-0000-4000-8000-0000000000fb', 'tech');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name) VALUES
  ('5a000000-0000-4000-8000-00000000a001', '0a000000-0000-4000-8000-0000000000fa', 'f0000000-0000-4000-8000-00000000a001', 'owner', 'Owner A'),
  ('5a000000-0000-4000-8000-00000000a002', '0a000000-0000-4000-8000-0000000000fa', 'f0000000-0000-4000-8000-00000000a002', 'tech', 'Tech A'),
  ('5a000000-0000-4000-8000-00000000a004', '0a000000-0000-4000-8000-0000000000fa', 'f0000000-0000-4000-8000-00000000a004', 'tech', 'Tech A Two'),
  ('5b000000-0000-4000-8000-00000000b001', '0b000000-0000-4000-8000-0000000000fb', 'f0000000-0000-4000-8000-00000000b001', 'tech', 'Tech B');

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c0000000-0000-4000-8000-0000000000fa', '0a000000-0000-4000-8000-0000000000fa', 'residential', 'Feed Client A'),
  ('c0000000-0000-4000-8000-0000000000fb', '0b000000-0000-4000-8000-0000000000fb', 'residential', 'Feed Client B');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, gate_code, lock_box_code, key_location) VALUES
  ('d0000000-0000-4000-8000-0000000000fa', '0a000000-0000-4000-8000-0000000000fa', 'c0000000-0000-4000-8000-0000000000fa',
   '1 Oak St', 'Springfield', '60614', 'GATE-A-4471', 'LOCKBOX-A-0915', 'KEY-A-BLUE-POT'),
  ('d0000000-0000-4000-8000-0000000000fb', '0b000000-0000-4000-8000-0000000000fb', 'c0000000-0000-4000-8000-0000000000fb',
   '9 Elm St', 'Shelbyville', '60615', 'GATE-B-9999', NULL, NULL);
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on) VALUES
  ('e0000000-0000-4000-8000-0000000000fa', '0a000000-0000-4000-8000-0000000000fa', 'c0000000-0000-4000-8000-0000000000fa',
   'd0000000-0000-4000-8000-0000000000fa', 'residential', 'weekly', 2400, 1, current_date),
  ('e0000000-0000-4000-8000-0000000000fb', '0b000000-0000-4000-8000-0000000000fb', 'c0000000-0000-4000-8000-0000000000fb',
   'd0000000-0000-4000-8000-0000000000fb', 'residential', 'weekly', 2400, 1, current_date);

-- Org A's day, which is what the window is measured on.
CREATE TEMP TABLE proof_day AS SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today;

INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, assigned_staff_id, status, eta_start, eta_end)
SELECT v.id::uuid, '0a000000-0000-4000-8000-0000000000fa', 'e0000000-0000-4000-8000-0000000000fa',
       'c0000000-0000-4000-8000-0000000000fa', 'd0000000-0000-4000-8000-0000000000fa',
       (SELECT today FROM proof_day) + v.off, v.staff::uuid, v.status::public.visit_status, v.eta_s, v.eta_e
  FROM (VALUES
    -- Tech A's: inside, inside and skipped, a week back (inside), too old, the far edge, past it.
    ('71000000-0000-4000-8000-000000000001',  3, '5a000000-0000-4000-8000-00000000a002', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour'),
    ('71000000-0000-4000-8000-000000000002',  2, '5a000000-0000-4000-8000-00000000a002', 'skipped',   NULL::timestamptz, NULL::timestamptz),
    ('71000000-0000-4000-8000-000000000003', -7, '5a000000-0000-4000-8000-00000000a002', 'completed', NULL, NULL),
    ('71000000-0000-4000-8000-000000000004', -8, '5a000000-0000-4000-8000-00000000a002', 'completed', NULL, NULL),
    ('71000000-0000-4000-8000-000000000005', 60, '5a000000-0000-4000-8000-00000000a002', 'scheduled', NULL, NULL),
    ('71000000-0000-4000-8000-000000000006', 61, '5a000000-0000-4000-8000-00000000a002', 'scheduled', NULL, NULL),
    -- Somebody else's, and nobody's.
    ('72000000-0000-4000-8000-000000000001',  4, '5a000000-0000-4000-8000-00000000a004', 'scheduled', NULL, NULL),
    ('72000000-0000-4000-8000-000000000002',  5, NULL,                                   'scheduled', NULL, NULL)
  ) AS v(id, off, staff, status, eta_s, eta_e);

INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, assigned_staff_id)
VALUES ('7b000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-0000000000fb', 'e0000000-0000-4000-8000-0000000000fb',
        'c0000000-0000-4000-8000-0000000000fb', 'd0000000-0000-4000-8000-0000000000fb',
        (SELECT today FROM proof_day) + 3, '5b000000-0000-4000-8000-00000000b001');

CREATE TEMP TABLE proof_hash (who text PRIMARY KEY, h text);
INSERT INTO proof_hash VALUES
  ('a2',  encode(sha256('token-for-tech-a'::bytea), 'hex')),
  ('a2b', encode(sha256('token-for-tech-a-rotated'::bytea), 'hex')),
  ('a3',  encode(sha256('token-for-dispatch-a-org'::bytea), 'hex')),
  ('a4',  encode(sha256('token-for-tech-a-two'::bytea), 'hex')),
  ('b1',  encode(sha256('token-for-tech-b'::bytea), 'hex')),
  ('x',   encode(sha256('a-token-nobody-was-given'::bytea), 'hex'));
GRANT SELECT ON proof_hash TO anon, authenticated;

-- ── Minting: each person, their own link, their own scope ───────────────────
SET LOCAL request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000a002","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _err text; _n int;
BEGIN
  PERFORM public.calendar_feed_rotate('mine', (SELECT h FROM proof_hash WHERE who = 'a2'));
  BEGIN
    PERFORM public.calendar_feed_rotate('org', (SELECT h FROM proof_hash WHERE who = 'x'));
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'not_authorized' THEN
    RAISE EXCEPTION 'PROOF FAILED [tech org feed]: a technician minted an all-visits link: %', COALESCE(_err, 'accepted');
  END IF;
  _err := NULL;
  BEGIN
    PERFORM public.calendar_feed_rotate('mine', 'not-a-hash');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'invalid_token_hash' THEN
    RAISE EXCEPTION 'PROOF FAILED [raw token]: something other than a hex digest was stored: %', COALESCE(_err, 'accepted');
  END IF;
  -- The table itself is closed, even to the person whose row it is.
  _err := NULL;
  BEGIN
    SELECT count(*) INTO _n FROM public.calendar_feeds;
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [table]: authenticated read calendar_feeds (% rows)', _n; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'a2'));
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [events]: authenticated called calendar_feed_events'; END IF;
  SELECT count(*) INTO _n FROM public.calendar_feed_status();
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [status]: the technician sees % links of their own, not 1', _n; END IF;
  RAISE NOTICE 'ok: a technician mints their own link, not an all-visits one, and cannot read the table or the feed function';
END $$;
RESET ROLE;
-- Back to the service role, as the public route calls it: no user in the JWT.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

SET LOCAL request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000a003","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.calendar_feed_rotate('mine', (SELECT h FROM proof_hash WHERE who = 'x'));
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'no_staff_record' THEN
    RAISE EXCEPTION 'PROOF FAILED [no staff]: a dispatcher with no staff record minted a my-visits link: %', COALESCE(_err, 'accepted');
  END IF;
  PERFORM public.calendar_feed_rotate('org', (SELECT h FROM proof_hash WHERE who = 'a3'));
  RAISE NOTICE 'ok: the dispatcher mints an all-visits link, and no my-visits link without a staff record';
END $$;
RESET ROLE;
-- Back to the service role, as the public route calls it: no user in the JWT.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

SET LOCAL request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000b001","role":"authenticated"}';
SET ROLE authenticated;
SELECT public.calendar_feed_rotate('mine', (SELECT h FROM proof_hash WHERE who = 'b1')) IS NOT NULL AS minted \gset
RESET ROLE;
-- Back to the service role, as the public route calls it: no user in the JWT.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

SET ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'a2'));
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon called calendar_feed_events'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.calendar_feed_rotate('mine', (SELECT h FROM proof_hash WHERE who = 'x'));
  EXCEPTION WHEN insufficient_privilege THEN _err := 'denied';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon called calendar_feed_rotate'; END IF;
  RAISE NOTICE 'ok: anon can call none of it';
END $$;
RESET ROLE;
-- Back to the service role, as the public route calls it: no user in the JWT.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

-- ── What a technician's own link serves (as the service role, like the route) ─
DO $$
DECLARE _doc jsonb; _ids text[];
BEGIN
  _doc := public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'a2'));
  IF _doc IS NULL OR _doc->>'scope' <> 'mine' THEN
    RAISE EXCEPTION 'PROOF FAILED [mine]: %', _doc;
  END IF;
  SELECT array_agg(e->>'id' ORDER BY e->>'id') INTO _ids FROM jsonb_array_elements(_doc->'events') e;
  IF _ids IS DISTINCT FROM ARRAY[
      '71000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002',
      '71000000-0000-4000-8000-000000000003', '71000000-0000-4000-8000-000000000005'] THEN
    RAISE EXCEPTION 'PROOF FAILED [mine window]: served %; wanted exactly the technician''s own visits from 7 days back to 60 ahead', _ids;
  END IF;
  IF (SELECT e->>'status' FROM jsonb_array_elements(_doc->'events') e
       WHERE e->>'id' = '71000000-0000-4000-8000-000000000002') <> 'skipped' THEN
    RAISE EXCEPTION 'PROOF FAILED [skipped]: the skipped visit lost its status';
  END IF;
  IF _doc::text ~ 'GATE-|LOCKBOX-|KEY-A' THEN
    RAISE EXCEPTION 'PROOF FAILED [codes off]: access codes served with the switch off: %', _doc;
  END IF;
  IF _doc::text ~ 'Feed Client B|9 Elm St|GATE-B' THEN
    RAISE EXCEPTION 'PROOF FAILED [cross tenant]: org B leaked into a technician''s feed: %', _doc;
  END IF;
  IF (SELECT last_fetched_at FROM public.calendar_feeds WHERE token_hash = (SELECT h FROM proof_hash WHERE who = 'a2')) IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [last fetched]: the poll was not recorded';
  END IF;
  RAISE NOTICE 'ok: a technician''s link serves their own visits in the window, the skip included, and nobody else''s';
END $$;

-- ── Wrong and rotated tokens ────────────────────────────────────────────────
DO $$
BEGIN
  IF public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'x')) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [wrong token]: an unknown hash served a feed';
  END IF;
  IF public.calendar_feed_events('token-for-tech-a') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [raw token]: the raw token was accepted in place of its hash';
  END IF;
  IF public.calendar_feed_events(NULL) IS NOT NULL OR public.calendar_feed_events('') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [empty token]: served a feed';
  END IF;
  RAISE NOTICE 'ok: an unknown, raw or empty token is refused';
END $$;

SET LOCAL request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000a002","role":"authenticated"}';
SET ROLE authenticated;
SELECT public.calendar_feed_rotate('mine', (SELECT h FROM proof_hash WHERE who = 'a2b')) IS NOT NULL AS rotated \gset
RESET ROLE;
-- Back to the service role, as the public route calls it: no user in the JWT.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
DO $$
BEGIN
  IF public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'a2')) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [rotated]: the old link still serves after a new one was made';
  END IF;
  IF public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'a2b')) IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [rotated]: the new link does not serve';
  END IF;
  IF (SELECT count(*) FROM public.calendar_feeds WHERE user_id = 'f0000000-0000-4000-8000-00000000a002') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [rotated]: rotating left more than one link behind';
  END IF;
  RAISE NOTICE 'ok: getting a new link kills the old one, and there is still only one';
END $$;

-- ── Access codes: the switch, and never on the org-wide feed ────────────────
UPDATE public.organizations SET calendar_feed_access_codes = true
 WHERE id = '0a000000-0000-4000-8000-0000000000fa';
DO $$
DECLARE _mine jsonb; _org jsonb; _ids text[];
BEGIN
  _mine := public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'a2b'));
  IF (SELECT e->>'gate_code' FROM jsonb_array_elements(_mine->'events') e
       WHERE e->>'id' = '71000000-0000-4000-8000-000000000001') IS DISTINCT FROM 'GATE-A-4471' THEN
    RAISE EXCEPTION 'PROOF FAILED [codes on]: the switch is on and the technician''s feed has no gate code: %', _mine;
  END IF;

  _org := public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'a3'));
  IF _org IS NULL OR _org->>'scope' <> 'org' THEN
    RAISE EXCEPTION 'PROOF FAILED [org]: %', _org;
  END IF;
  IF _org::text ~ 'GATE-|LOCKBOX-|KEY-A' THEN
    RAISE EXCEPTION 'PROOF FAILED [org codes]: the all-visits feed carries access codes: %', _org;
  END IF;
  SELECT array_agg(e->>'id' ORDER BY e->>'id') INTO _ids FROM jsonb_array_elements(_org->'events') e;
  IF _ids IS DISTINCT FROM ARRAY[
      '71000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002',
      '71000000-0000-4000-8000-000000000003', '71000000-0000-4000-8000-000000000005',
      '72000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000002'] THEN
    RAISE EXCEPTION 'PROOF FAILED [org window]: served %', _ids;
  END IF;
  IF _org::text ~ 'Feed Client B|9 Elm St|GATE-B|7b000000' THEN
    RAISE EXCEPTION 'PROOF FAILED [org cross tenant]: org B leaked into org A''s all-visits feed';
  END IF;

  -- And org B's technician sees org B, only.
  SELECT array_agg(e->>'id') INTO _ids
    FROM jsonb_array_elements(public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'b1'))->'events') e;
  IF _ids IS DISTINCT FROM ARRAY['7b000000-0000-4000-8000-000000000001'] THEN
    RAISE EXCEPTION 'PROOF FAILED [org B]: served %', _ids;
  END IF;
  RAISE NOTICE 'ok: codes reach a technician''s own feed only when switched on, never the all-visits feed, and no feed crosses a tenant';
END $$;

-- ── A link does not outlive the reason it was allowed ───────────────────────
UPDATE public.user_roles SET role = 'tech'
 WHERE user_id = 'f0000000-0000-4000-8000-00000000a003';
UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-00000000a002';
DELETE FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-00000000b001';
DO $$
BEGIN
  IF public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'a3')) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [demoted]: an all-visits link still serves after its holder lost the role';
  END IF;
  IF public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'a2b')) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [deactivated]: a deactivated technician''s link still serves';
  END IF;
  IF public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'b1')) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [removed]: a link still serves after its holder left the organization';
  END IF;
  RAISE NOTICE 'ok: demoted, deactivated or removed, the link stops serving';
END $$;

-- ── Turning a link off ──────────────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"sub":"f0000000-0000-4000-8000-00000000a004","role":"authenticated"}';
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.calendar_feed_rotate('mine', (SELECT h FROM proof_hash WHERE who = 'a4'));
  IF NOT public.calendar_feed_revoke('mine') THEN
    RAISE EXCEPTION 'PROOF FAILED [revoke]: nothing was turned off';
  END IF;
END $$;
RESET ROLE;
-- Back to the service role, as the public route calls it: no user in the JWT.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
DO $$
BEGIN
  IF public.calendar_feed_events((SELECT h FROM proof_hash WHERE who = 'a4')) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [revoke]: a link that was turned off still serves';
  END IF;
  RAISE NOTICE 'ok: a link that was turned off stops serving';
END $$;

\echo ALL CALENDAR FEED PROOFS PASSED
ROLLBACK;
