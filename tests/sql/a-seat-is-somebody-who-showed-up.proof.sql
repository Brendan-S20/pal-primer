-- Who counts as a seat, proved against a real Postgres rather than read off
-- the migration's text. Run by tests/a-seat-is-somebody-who-showed-up.test.ts,
-- which passes the migration's path as :migration.
--
-- The rule (owner, 2026-10-09): an active employee for billing is anyone who
-- used their login at least once during the billing period, in any role.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included, so this can be pointed at a shared local stack
-- without leaving a table or a row behind. Each group prints "ok: ..." only
-- when every check in it passed, or raises "PROOF FAILED [...]", and
-- ON_ERROR_STOP turns the first failure into a non-zero exit.
--
-- now() is fixed for the whole transaction, so the period checks move the
-- PERIOD (and backdate ledger rows as the service role) rather than the clock.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Org A (on a subscription): Olive the owner; techs Sam, Priya, Nina, Tia,
-- Vic and Mo; Ada, who is also a platform admin. Org B (trial, no
-- subscription): Omar.
SELECT set_config('request.jwt.claims', '{}', true);
INSERT INTO auth.users (id, email) VALUES
  ('a5000000-0000-4000-8000-00000000a001', 'olive-a@seats.proof.invalid'),
  ('a5000000-0000-4000-8000-00000000a002', 'sam-a@seats.proof.invalid'),
  ('a5000000-0000-4000-8000-00000000a003', 'priya-a@seats.proof.invalid'),
  ('a5000000-0000-4000-8000-00000000a004', 'nina-a@seats.proof.invalid'),
  ('a5000000-0000-4000-8000-00000000a005', 'tia-a@seats.proof.invalid'),
  ('a5000000-0000-4000-8000-00000000a006', 'vic-a@seats.proof.invalid'),
  ('a5000000-0000-4000-8000-00000000a007', 'mo-a@seats.proof.invalid'),
  ('a5000000-0000-4000-8000-00000000a008', 'ada-a@seats.proof.invalid'),
  ('b5000000-0000-4000-8000-00000000b001', 'omar-b@seats.proof.invalid');

SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone, stripe_subscription_id) VALUES
  ('0a500000-0000-4000-8000-0000000000aa', 'Seats Proof A', 'America/Chicago', 'sub_seatsproofA1'),
  ('0b500000-0000-4000-8000-0000000000bb', 'Seats Proof B', 'America/Chicago', NULL);
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a5000000-0000-4000-8000-00000000a001', '0a500000-0000-4000-8000-0000000000aa', 'owner'),
  ('a5000000-0000-4000-8000-00000000a002', '0a500000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5000000-0000-4000-8000-00000000a003', '0a500000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5000000-0000-4000-8000-00000000a004', '0a500000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5000000-0000-4000-8000-00000000a005', '0a500000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5000000-0000-4000-8000-00000000a006', '0a500000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5000000-0000-4000-8000-00000000a007', '0a500000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5000000-0000-4000-8000-00000000a008', '0a500000-0000-4000-8000-0000000000aa', 'office_manager'),
  ('b5000000-0000-4000-8000-00000000b001', '0b500000-0000-4000-8000-0000000000bb', 'tech');

INSERT INTO public.staff (id, organization_id, user_id, display_name, role, active) VALUES
  ('5a000000-0000-4000-8000-00000000a001', '0a500000-0000-4000-8000-0000000000aa', 'a5000000-0000-4000-8000-00000000a001', 'Olive', 'owner', true),
  ('5a000000-0000-4000-8000-00000000a002', '0a500000-0000-4000-8000-0000000000aa', 'a5000000-0000-4000-8000-00000000a002', 'Sam', 'tech', true),
  ('5a000000-0000-4000-8000-00000000a003', '0a500000-0000-4000-8000-0000000000aa', 'a5000000-0000-4000-8000-00000000a003', 'Priya', 'tech', true),
  ('5a000000-0000-4000-8000-00000000a004', '0a500000-0000-4000-8000-0000000000aa', 'a5000000-0000-4000-8000-00000000a004', 'Nina', 'tech', true),
  ('5a000000-0000-4000-8000-00000000a005', '0a500000-0000-4000-8000-0000000000aa', 'a5000000-0000-4000-8000-00000000a005', 'Tia', 'tech', true),
  ('5a000000-0000-4000-8000-00000000a006', '0a500000-0000-4000-8000-0000000000aa', 'a5000000-0000-4000-8000-00000000a006', 'Vic', 'tech', true),
  ('5a000000-0000-4000-8000-00000000a007', '0a500000-0000-4000-8000-0000000000aa', 'a5000000-0000-4000-8000-00000000a007', 'Mo', 'tech', true),
  ('5a000000-0000-4000-8000-00000000a008', '0a500000-0000-4000-8000-0000000000aa', 'a5000000-0000-4000-8000-00000000a008', 'Ada', 'office_manager', true),
  ('5b000000-0000-4000-8000-00000000b001', '0b500000-0000-4000-8000-0000000000bb', 'b5000000-0000-4000-8000-00000000b001', 'Omar', 'tech', true);

INSERT INTO public.platform_admins (user_id) VALUES ('a5000000-0000-4000-8000-00000000a008');

-- Mo turned two-step sign-in on.
INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
VALUES (gen_random_uuid(), 'a5000000-0000-4000-8000-00000000a007', 'Phone', 'totp', 'verified', now(), now(), 'x');

-- A platform admin's grant to view Org A as Nina, consumed, with the minted
-- session's id recorded the way consumeImpersonation records it.
INSERT INTO public.impersonation_grants
  (token_hash, organization_id, target_user_id, actor_user_id, expires_at, consumed_at, auth_session_id, session_expires_at)
VALUES
  ('seats-proof-grant', '0a500000-0000-4000-8000-0000000000aa', 'a5000000-0000-4000-8000-00000000a004',
   'a5000000-0000-4000-8000-00000000a008', now() + interval '10 minutes', now(),
   'ee500000-0000-4000-8000-0000000000ee', now() + interval '1 hour');

CREATE FUNCTION pg_temp.as_user(_uid text, _session text DEFAULT NULL, _aal text DEFAULT 'aal1') RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', _aal,
                             'session_id', COALESCE(_session, gen_random_uuid()::text))::text, true);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(text, text, text) TO authenticated, anon;

CREATE FUNCTION pg_temp.seen(_uid text, _session text DEFAULT NULL, _aal text DEFAULT 'aal1') RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.as_user(_uid, _session, _aal);
  RETURN public.note_staff_seen();
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.seen(text, text, text) TO authenticated;

-- ── 1. Somebody using the app is seen, once a day ───────────────────────────
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a002');
  IF NOT (_r->>'stamped')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [seen]: Sam using the app was not recorded: %', _r;
  END IF;
  IF _r->>'organization_id' <> '0a500000-0000-4000-8000-0000000000aa' THEN
    RAISE EXCEPTION 'PROOF FAILED [seen]: recorded against the wrong org: %', _r;
  END IF;
  -- On a subscription, never reconciled: the seat line needs looking at.
  IF NOT (_r->>'needs_seat_sync')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [seen]: a first sighting on a subscribed org asked for no reconcile: %', _r;
  END IF;

  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a002');
  IF (_r->>'stamped')::boolean OR _r->>'why' <> 'already_today' THEN
    RAISE EXCEPTION 'PROOF FAILED [once a day]: the second call wrote again: %', _r;
  END IF;
  RAISE NOTICE 'ok: somebody using the app is recorded once a day, and asks for a reconcile';
END $$;
RESET ROLE;

-- ── 2. The owner counts like anyone else ────────────────────────────────────
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a001');
  IF NOT (_r->>'stamped')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: the owner using the app was not recorded: %', _r;
  END IF;
  RAISE NOTICE 'ok: the owner is seen like anybody else';
END $$;
RESET ROLE;

-- ── 3. Viewing as somebody is not somebody using the app ────────────────────
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  -- Nina's own JWT, but the session the impersonation grant minted.
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a004', 'ee500000-0000-4000-8000-0000000000ee');
  IF (_r->>'stamped')::boolean OR _r->>'why' <> 'impersonation' THEN
    RAISE EXCEPTION 'PROOF FAILED [impersonation]: an impersonated session counted a seat: %', _r;
  END IF;
  -- And the platform admin's own session, in an org they also belong to.
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a008');
  IF (_r->>'stamped')::boolean OR _r->>'why' <> 'platform_admin' THEN
    RAISE EXCEPTION 'PROOF FAILED [platform admin]: a platform admin counted a seat: %', _r;
  END IF;
  RAISE NOTICE 'ok: an impersonation session and a platform admin are never a tenant''s seat';
END $$;
RESET ROLE;

-- ── 4. Not in yet, or signed out, is not seen ───────────────────────────────
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a007', NULL, 'aal1');
  IF (_r->>'stamped')::boolean OR _r->>'why' <> 'second_step_pending' THEN
    RAISE EXCEPTION 'PROOF FAILED [two-step]: a password-only session of a two-step user counted: %', _r;
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  _r := public.note_staff_seen();
  IF (_r->>'stamped')::boolean OR _r->>'why' <> 'signed_out' THEN
    RAISE EXCEPTION 'PROOF FAILED [signed out]: %', _r;
  END IF;
  RAISE NOTICE 'ok: a session that has not finished signing in is not a sighting';
END $$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.note_staff_seen();
    RAISE EXCEPTION 'PROOF FAILED [anon]: anon could record a sighting';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: anon cannot call note_staff_seen';
END $$;
RESET ROLE;

-- ── 5. Worked this period, then left: still on this period's bill ───────────
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a003');
  IF NOT (_r->>'stamped')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [leaver]: Priya was not recorded before leaving: %', _r;
  END IF;
END $$;
RESET ROLE;
UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-00000000a003';
-- She is not seen again once deactivated: a fresh day would not stamp her.
DELETE FROM public.staff_seen_days WHERE staff_id = '5a000000-0000-4000-8000-00000000a003' AND seen_on = (now() AT TIME ZONE 'UTC')::date;
INSERT INTO public.staff_seen_days (organization_id, staff_id, seen_on, first_seen_at, last_seen_at)
VALUES ('0a500000-0000-4000-8000-0000000000aa', '5a000000-0000-4000-8000-00000000a003',
        (now() AT TIME ZONE 'UTC')::date - 1, now() - interval '1 day', now() - interval '1 day');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a003');
  IF (_r->>'stamped')::boolean OR _r->>'why' <> 'not_active_staff' THEN
    RAISE EXCEPTION 'PROOF FAILED [leaver]: a deactivated person was stamped: %', _r;
  END IF;
  RAISE NOTICE 'ok: a deactivated person is not seen again';
END $$;
RESET ROLE;

-- ── 6. The count ────────────────────────────────────────────────────────────
-- Seen since two days ago: Sam, Olive, and Priya (yesterday, now deactivated).
-- Not Nina (only ever impersonated), not Ada (platform admin), not Mo (never
-- finished signing in), not Tia or Vic (have not used it), not Omar (Org B).
DO $$
DECLARE _n integer;
BEGIN
  _n := public.billable_seat_count('0a500000-0000-4000-8000-0000000000aa', now() - interval '2 days');
  IF _n <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [count]: Org A counts % seats, expected 3 (Sam, Olive, Priya)', _n;
  END IF;
  -- Priya was seen yesterday, so a period that began today does not include her.
  _n := public.billable_seat_count('0a500000-0000-4000-8000-0000000000aa', now() - interval '1 hour');
  IF _n <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [count]: a period that began today counts %, expected 2', _n;
  END IF;
  _n := public.billable_seat_count('0b500000-0000-4000-8000-0000000000bb', now() - interval '2 days');
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [count]: Org B counts % before Omar used the app', _n;
  END IF;
  RAISE NOTICE 'ok: the count is the people who used their login since the period began, leavers included';
END $$;

-- An org with no subscription is seen, and asks for no reconcile.
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := pg_temp.seen('b5000000-0000-4000-8000-00000000b001');
  IF NOT (_r->>'stamped')::boolean OR (_r->>'needs_seat_sync')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [trial]: %', _r;
  END IF;
  RAISE NOTICE 'ok: an org with no subscription is recorded and asks Stripe nothing';
END $$;
RESET ROLE;
DO $$
BEGIN
  IF public.billable_seat_count('0a500000-0000-4000-8000-0000000000aa', now() - interval '2 days') <> 3
     OR public.billable_seat_count('0b500000-0000-4000-8000-0000000000bb', now() - interval '2 days') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [isolation]: one org''s sighting moved the other''s count';
  END IF;
  RAISE NOTICE 'ok: each org counts only its own people';
END $$;

-- ── 7. The period ───────────────────────────────────────────────────────────
-- The seat line was last reconciled for a period that began ten days ago.
INSERT INTO public.org_seat_periods (organization_id, period_start, period_end, billable_seats, seat_quantity)
VALUES ('0a500000-0000-4000-8000-0000000000aa', now() - interval '10 days', now() + interval '20 days', 2, 0);
-- Tia last used the app fifteen days ago, in the period before.
INSERT INTO public.staff_seen_days (organization_id, staff_id, seen_on, first_seen_at, last_seen_at)
VALUES ('0a500000-0000-4000-8000-0000000000aa', '5a000000-0000-4000-8000-00000000a005',
        (now() AT TIME ZONE 'UTC')::date - 15, now() - interval '15 days', now() - interval '15 days');
DO $$
BEGIN
  IF public.billable_seat_count('0a500000-0000-4000-8000-0000000000aa', now() - interval '10 days') <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [period]: last period''s sighting counted in this one';
  END IF;
END $$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a005');
  IF NOT (_r->>'stamped')::boolean OR NOT (_r->>'needs_seat_sync')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [period]: Tia''s first sighting this period asked for no reconcile: %', _r;
  END IF;
  RAISE NOTICE 'ok: a person''s first sighting in the period asks for a reconcile';
END $$;
RESET ROLE;
DO $$
BEGIN
  IF public.billable_seat_count('0a500000-0000-4000-8000-0000000000aa', now() - interval '10 days') <> 4 THEN
    RAISE EXCEPTION 'PROOF FAILED [period]: Tia was not counted after using the app this period';
  END IF;
END $$;

-- A person already seen this period, seen again on a new day: no reconcile,
-- the count cannot have moved.
INSERT INTO public.staff_seen_days (organization_id, staff_id, seen_on, first_seen_at, last_seen_at)
VALUES ('0a500000-0000-4000-8000-0000000000aa', '5a000000-0000-4000-8000-00000000a006',
        (now() AT TIME ZONE 'UTC')::date - 3, now() - interval '3 days', now() - interval '3 days');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a006');
  IF NOT (_r->>'stamped')::boolean OR (_r->>'needs_seat_sync')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [period]: Vic, already counted, asked for a reconcile: %', _r;
  END IF;
  RAISE NOTICE 'ok: somebody already counted this period does not ask Stripe again';
END $$;
RESET ROLE;

-- A renewal on the same day: Sam was stamped an hour ago, and a new period
-- began half an hour ago. Using the app again re-stamps him for the new one.
UPDATE public.staff_seen_days SET first_seen_at = now() - interval '1 hour', last_seen_at = now() - interval '1 hour'
 WHERE staff_id = '5a000000-0000-4000-8000-00000000a002';
UPDATE public.org_seat_periods SET period_start = now() - interval '30 minutes', period_end = now() + interval '30 days'
 WHERE organization_id = '0a500000-0000-4000-8000-0000000000aa';
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a002');
  IF NOT (_r->>'stamped')::boolean OR NOT (_r->>'needs_seat_sync')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [renewal day]: Sam on both sides of a renewal was not re-stamped: %', _r;
  END IF;
  RAISE NOTICE 'ok: using the app either side of a renewal counts on both sides';
END $$;
RESET ROLE;
DO $$
BEGIN
  IF public.billable_seat_count('0a500000-0000-4000-8000-0000000000aa', now() - interval '30 minutes') < 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [renewal day]: the new period does not count Sam';
  END IF;
END $$;

-- The recorded period is over: the next sighting asks for a reconcile even
-- from somebody already counted, so the seat line rolls over.
UPDATE public.org_seat_periods SET period_start = now() - interval '31 days', period_end = now() - interval '1 second'
 WHERE organization_id = '0a500000-0000-4000-8000-0000000000aa';
DELETE FROM public.staff_seen_days WHERE staff_id = '5a000000-0000-4000-8000-00000000a006' AND seen_on = (now() AT TIME ZONE 'UTC')::date;
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := pg_temp.seen('a5000000-0000-4000-8000-00000000a006');
  IF NOT (_r->>'stamped')::boolean OR NOT (_r->>'needs_seat_sync')::boolean THEN
    RAISE EXCEPTION 'PROOF FAILED [rollover]: a sighting after the period ended asked for no reconcile: %', _r;
  END IF;
  RAISE NOTICE 'ok: the first sighting after a period ends asks for a reconcile';
END $$;
RESET ROLE;

-- ── 8. Who can read it, and nobody can write it ─────────────────────────────
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n integer;
BEGIN
  -- A tech sees nothing.
  PERFORM pg_temp.as_user('a5000000-0000-4000-8000-00000000a002');
  SELECT count(*) INTO _n FROM public.staff_seen_days;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [read]: a tech reads % ledger rows', _n; END IF;
  SELECT count(*) INTO _n FROM public.org_seat_periods;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [read]: a tech reads the seat period'; END IF;

  -- The owner sees her own org's ledger and nobody else's.
  PERFORM pg_temp.as_user('a5000000-0000-4000-8000-00000000a001');
  SELECT count(*) INTO _n FROM public.staff_seen_days WHERE organization_id = '0a500000-0000-4000-8000-0000000000aa';
  IF _n = 0 THEN RAISE EXCEPTION 'PROOF FAILED [read]: the owner cannot see who is on her bill'; END IF;
  SELECT count(*) INTO _n FROM public.staff_seen_days WHERE organization_id <> '0a500000-0000-4000-8000-0000000000aa';
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [read]: the owner reads % rows of another org', _n; END IF;

  -- Nobody writes the ledger directly: not to add a sighting, not to remove one.
  BEGIN
    DELETE FROM public.staff_seen_days;
    RAISE EXCEPTION 'PROOF FAILED [write]: the owner could delete sightings';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.staff_seen_days (organization_id, staff_id, seen_on)
    VALUES ('0a500000-0000-4000-8000-0000000000aa', '5a000000-0000-4000-8000-00000000a004', CURRENT_DATE);
    RAISE EXCEPTION 'PROOF FAILED [write]: a client could write a sighting';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.org_seat_periods SET period_start = now() + interval '1 year';
    RAISE EXCEPTION 'PROOF FAILED [write]: the owner could move the seat period';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.billable_seat_count('0a500000-0000-4000-8000-0000000000aa', now() - interval '1 day');
    RAISE EXCEPTION 'PROOF FAILED [count]: a signed-in user could call billable_seat_count';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: the owner reads her own ledger, a tech reads none, and nobody writes it';
END $$;
RESET ROLE;

ROLLBACK;

\echo ALL SEAT PROOFS PASSED
