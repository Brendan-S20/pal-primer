-- A seat is somebody who showed up.
--
-- The owner's decision (2026-10-09): an "active employee" for billing is
-- ANYONE WHO USED THEIR LOGIN AT LEAST ONCE DURING THE BILLING PERIOD, in any
-- role. Somebody on the team who never opened the app that period costs
-- nothing. The marketing site promised this; until now the app counted
-- `staff.active = true` at whatever moment a seat sync happened to run.
--
-- `auth.users.last_sign_in_at` cannot answer the question: a Supabase session
-- refreshes silently, so a tech who stays signed in for months never "signs
-- in" again. What is needed is a sighting recorded while somebody is actually
-- USING the app, and that is what this file adds.
--
-- ── WHAT IS HERE ──────────────────────────────────────────────────────────
--
--   staff_seen_days   one row per person per UTC day they used the app. The
--                     ledger the seat count is read from, and the answer to
--                     "who did I pay for in September?" long after.
--   org_seat_periods  the Stripe period an org's seat line was last
--                     reconciled for, written by the seat sync (service
--                     role). It lets a sighting say "this person is new this
--                     period, reconcile now" without asking Stripe.
--   note_staff_seen() the only writer of the ledger. Called with the
--                     caller's own JWT; it can only ever stamp the caller.
--   billable_seat_count(org, since)
--                     distinct people seen in the org since a moment. Service
--                     role only: it is what Stripe is told.
--
-- ── WHY A LEDGER AND NOT staff.last_seen_at ───────────────────────────────
--
-- A single column answers "seen this period" only for the CURRENT period, and
-- an owner can UPDATE their own staff rows: stamp everyone's last_seen_at
-- into 2099 and the once-a-day throttle never writes again, so nobody is ever
-- counted. The ledger is written only by the SECURITY DEFINER function below;
-- `authenticated` holds SELECT on it and nothing else.
--
-- ── THE DECISIONS, ONE PER EDGE ───────────────────────────────────────────
--
--   * Used the app this period, then deactivated: COUNTS for this period.
--     Their rows are already in the ledger and nothing deletes them. They do
--     not count next period, because a deactivated person is never stamped.
--   * A brand-new hire: counts from the first time they use the app, for the
--     period that use falls in. An invite never accepted, or an account that
--     never opens the app, costs nothing.
--   * The owner: counts like anybody else ("in any role"). An owner who did
--     not open the app all period is not counted either.
--   * An impersonation session (a platform admin "viewing as" a tenant user)
--     is NOT a sighting of that user: the session's JWT `session_id` is on an
--     impersonation_grants row. Nor is any session of a platform admin.
--   * A password-only session of somebody who has two-step sign-in on is not
--     a sighting: they have not got into the app yet.
--   * The demo org is stamped like any org (harmless, and it keeps the ledger
--     honest), but it is never billed: seat-sync.server.ts skips it before
--     touching Stripe.
--   * An offline tech is counted when their queued work reaches the server,
--     in the period it lands in. One period, never zero, never two.
--
-- Replays into an empty database: two tables, their policies, two functions.
-- The check block asserts only what this file establishes and needs no row.

-- ── 1. THE LEDGER ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_seen_days (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Deliberately NOT a foreign key to staff: a staff row deleted after its
  -- person worked this period must still be counted for this period.
  staff_id uuid NOT NULL,
  -- The UTC day. The throttle: at most one write per person per day.
  seen_on date NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  -- The latest STAMP that day (not the latest request). Re-stamped the same
  -- day only when a billing period has begun since the last stamp, so a
  -- person who used the app either side of a renewal counts on both sides.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, seen_on),
  CONSTRAINT staff_seen_days_order CHECK (last_seen_at >= first_seen_at)
);

COMMENT ON TABLE public.staff_seen_days IS
  'One row per staff member per UTC day they used the app. The seat count Stripe bills is read from here (billable_seat_count). Written only by note_staff_seen(); never by a client directly.';

-- The count: one org, everything since a moment.
CREATE INDEX IF NOT EXISTS staff_seen_days_org_last_seen
  ON public.staff_seen_days (organization_id, last_seen_at);

ALTER TABLE public.staff_seen_days ENABLE ROW LEVEL SECURITY;
-- Two-step sign-in, like every RLS table (20261002010000_a-password-was-the-only-lock).
SELECT public.require_mfa_policy('public.staff_seen_days');

REVOKE ALL ON public.staff_seen_days FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.staff_seen_days TO authenticated;
GRANT ALL ON public.staff_seen_days TO service_role;

-- Whoever can see the bill can see who is on it.
DROP POLICY IF EXISTS "staff seen days: owners and office managers (select)" ON public.staff_seen_days;
CREATE POLICY "staff seen days: owners and office managers (select)" ON public.staff_seen_days
  FOR SELECT TO authenticated
  USING (
    public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
    OR public.has_role((SELECT auth.uid()), organization_id, 'office_manager'::public.app_role)
  );

-- ── 2. THE PERIOD THE SEAT LINE WAS LAST RECONCILED FOR ───────────────────
CREATE TABLE IF NOT EXISTS public.org_seat_periods (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  -- People seen in [period_start, synced_at], and the overage quantity Stripe
  -- was left holding. Null quantity: not a per-employee plan.
  billable_seats integer NOT NULL DEFAULT 0,
  seat_quantity integer,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_seat_periods_order CHECK (period_end > period_start),
  CONSTRAINT org_seat_periods_counts CHECK (billable_seats >= 0 AND (seat_quantity IS NULL OR seat_quantity >= 0))
);

COMMENT ON TABLE public.org_seat_periods IS
  'The Stripe billing period an org''s seat line was last reconciled for. Written by syncOrgSeatQuantity on the service role; read by note_staff_seen() to know when a sighting changes the count.';

ALTER TABLE public.org_seat_periods ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.org_seat_periods');

REVOKE ALL ON public.org_seat_periods FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.org_seat_periods TO authenticated;
GRANT ALL ON public.org_seat_periods TO service_role;

DROP POLICY IF EXISTS "org seat periods: owners and office managers (select)" ON public.org_seat_periods;
CREATE POLICY "org seat periods: owners and office managers (select)" ON public.org_seat_periods
  FOR SELECT TO authenticated
  USING (
    public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
    OR public.has_role((SELECT auth.uid()), organization_id, 'office_manager'::public.app_role)
  );

-- ── 3. THE SIGHTING ───────────────────────────────────────────────────────
-- Returns what happened, so the server can decide whether Stripe needs
-- reconciling now:
--   { stamped: bool, why?: text, organization_id?: uuid, needs_seat_sync?: bool }
-- `needs_seat_sync` is true when this stamp can have changed the count for
-- the period the seat line was last reconciled for -- the person's first
-- sighting in it -- or when that period is over or was never recorded.
CREATE OR REPLACE FUNCTION public.note_staff_seen()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _uid uuid := auth.uid();
  _sid text := NULLIF(auth.jwt() ->> 'session_id', '');
  _today date := (now() AT TIME ZONE 'UTC')::date;
  _staff_id uuid;
  _org_id uuid;
  _has_sub boolean;
  _p_start timestamptz;
  _p_end timestamptz;
  _today_last timestamptz;
  _prev timestamptz;
BEGIN
  IF _uid IS NULL THEN
    RETURN jsonb_build_object('stamped', false, 'why', 'signed_out');
  END IF;

  -- A platform admin "viewing as" this user is not this user using the app.
  -- Any grant, ended or not: a session minted for impersonation never becomes
  -- the user's own.
  IF _sid IS NOT NULL
     AND _sid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.impersonation_grants g WHERE g.auth_session_id = _sid::uuid) THEN
    RETURN jsonb_build_object('stamped', false, 'why', 'impersonation');
  END IF;

  IF public.is_platform_admin(_uid) THEN
    RETURN jsonb_build_object('stamped', false, 'why', 'platform_admin');
  END IF;

  -- Password-only session of a two-step user: not in the app yet.
  IF NOT public.mfa_satisfied() THEN
    RETURN jsonb_build_object('stamped', false, 'why', 'second_step_pending');
  END IF;

  -- The org the app resolves for this user (user_roles), and their staff row
  -- in it. Active at the moment of use: a deactivated person is never seen.
  SELECT s.id, s.organization_id
    INTO _staff_id, _org_id
    FROM public.user_roles ur
    JOIN public.staff s ON s.user_id = ur.user_id AND s.organization_id = ur.organization_id
   WHERE ur.user_id = _uid AND s.active
   LIMIT 1;
  IF _staff_id IS NULL THEN
    RETURN jsonb_build_object('stamped', false, 'why', 'not_active_staff');
  END IF;

  SELECT p.period_start, p.period_end INTO _p_start, _p_end
    FROM public.org_seat_periods p WHERE p.organization_id = _org_id;

  -- The throttle, read-only: already stamped today, and since the period
  -- began. Ninety-nine calls in a hundred end here.
  SELECT d.last_seen_at INTO _today_last
    FROM public.staff_seen_days d WHERE d.staff_id = _staff_id AND d.seen_on = _today;
  IF _today_last IS NOT NULL AND (_p_start IS NULL OR _today_last >= _p_start) THEN
    RETURN jsonb_build_object('stamped', false, 'why', 'already_today', 'organization_id', _org_id);
  END IF;

  SELECT max(d.last_seen_at) INTO _prev FROM public.staff_seen_days d WHERE d.staff_id = _staff_id;

  INSERT INTO public.staff_seen_days (organization_id, staff_id, seen_on)
  VALUES (_org_id, _staff_id, _today)
  ON CONFLICT (staff_id, seen_on) DO UPDATE SET last_seen_at = now();

  SELECT o.stripe_subscription_id IS NOT NULL INTO _has_sub
    FROM public.organizations o WHERE o.id = _org_id;

  RETURN jsonb_build_object(
    'stamped', true,
    'organization_id', _org_id,
    'needs_seat_sync', COALESCE(_has_sub, false) AND (
      _p_start IS NULL
      OR now() >= _p_end
      OR _prev IS NULL
      OR _prev < _p_start
    )
  );
END;
$fn$;

COMMENT ON FUNCTION public.note_staff_seen() IS
  'Records that the CALLER used the app today (staff_seen_days). Refuses impersonation sessions, platform admins, password-only two-step sessions and inactive staff. At most one write per person per UTC day.';

REVOKE ALL ON FUNCTION public.note_staff_seen() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.note_staff_seen() TO authenticated;

-- ── 4. THE COUNT ──────────────────────────────────────────────────────────
-- Distinct people seen in the org since a moment (the start of the Stripe
-- period). Not filtered on staff.active, on purpose: somebody who worked this
-- period and left still worked this period.
CREATE OR REPLACE FUNCTION public.billable_seat_count(_org_id uuid, _since timestamptz)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT count(DISTINCT d.staff_id)::integer
    FROM public.staff_seen_days d
   WHERE d.organization_id = _org_id
     AND d.last_seen_at >= _since;
$fn$;

COMMENT ON FUNCTION public.billable_seat_count(uuid, timestamptz) IS
  'People who used their login in the org since _since: the seat count Stripe is told. Service role only.';

REVOKE ALL ON FUNCTION public.billable_seat_count(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billable_seat_count(uuid, timestamptz) TO service_role;

-- ── 5. WHAT THIS FILE ESTABLISHES ─────────────────────────────────────────
DO $check$
DECLARE
  _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['staff_seen_days', 'org_seat_periods'] LOOP
    IF to_regclass('public.' || _t) IS NULL THEN
      RAISE EXCEPTION '% was not created', _t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || _t)::regclass) THEN
      RAISE EXCEPTION 'RLS is not enabled on %', _t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = _t
         AND permissive = 'RESTRICTIVE' AND policyname = 'two-step sign-in, when the user has it'
    ) THEN
      RAISE EXCEPTION '% has no two-step sign-in policy', _t;
    END IF;
    -- Read-only to the API roles. A client that could write a sighting could
    -- write somebody else's, or delete its own and drop off the bill.
    IF has_table_privilege('anon', 'public.' || _t, 'SELECT')
       OR has_table_privilege('anon', 'public.' || _t, 'INSERT') THEN
      RAISE EXCEPTION 'anon holds a privilege on %', _t;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || _t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || _t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || _t, 'DELETE')
       OR has_table_privilege('authenticated', 'public.' || _t, 'TRUNCATE') THEN
      RAISE EXCEPTION 'authenticated can write %', _t;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = _t
         AND permissive = 'PERMISSIVE' AND cmd <> 'SELECT'
    ) THEN
      RAISE EXCEPTION '% has a permissive policy for something other than SELECT', _t;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.note_staff_seen()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call note_staff_seen()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.note_staff_seen()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a signed-in user cannot record their own sighting';
  END IF;
  IF has_function_privilege('authenticated', 'public.billable_seat_count(uuid, timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.billable_seat_count(uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'billable_seat_count is callable from the API; it is service role only';
  END IF;
END
$check$;
