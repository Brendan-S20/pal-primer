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
-- ── HOW IT IS BILLED (owner, 2026-10-09) ──────────────────────────────────
--
-- Seats are billed AFTER each seat period closes, as their own invoice line
-- dated for the period they cover ("Extra active employees, Sep 9 – Oct 8").
-- A seat period is one month, on monthly and yearly plans alike: a yearly
-- plan's extra seats are counted and billed month by month. The final period
-- of a cancelled subscription is billed once, when it ends. A period that was
-- already prepaid under the old headcount rule stays paid; the new rule starts
-- with the next one. The Stripe side is src/lib/seat-charges.server.ts.
--
-- ── WHAT IS HERE ──────────────────────────────────────────────────────────
--
--   staff_seen_days   one row per person per UTC day they used the app. The
--                     ledger the seat count is read from, and the answer to
--                     "who did I pay for in September?" long after.
--   org_seat_periods  the seat period an org is in now. Lets a sighting tell
--                     that a new period began earlier today.
--   seat_charges      one row per subscription per seat period: what was
--                     counted and what was charged. Its unique key is what
--                     makes every period billed EXACTLY once.
--   note_staff_seen() the only writer of the sightings. Called with the
--                     caller's own JWT; it can only ever stamp the caller.
--   billable_seat_count(org, from, to)
--                     distinct people seen in the org in [from, to).
--   claim_seat_charge(...)
--                     claims a period for billing, or says why not.
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
--     honest), but it is never billed: seat-charges.server.ts skips it, and
--     every comped org, before touching Stripe.
--   * An offline tech is counted when their queued work reaches the server,
--     in the period it lands in. One period, never zero, never two.
--
-- Replays into an empty database: three tables, their policies, three
-- functions. The check block asserts only what this file establishes and
-- needs no row.

-- ── 1. THE SIGHTINGS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_seen_days (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Deliberately NOT a foreign key to staff: a staff row deleted after its
  -- person worked this period must still be counted for this period.
  staff_id uuid NOT NULL,
  -- The UTC day. The throttle: at most one write per person per day.
  seen_on date NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  -- The latest STAMP that day (not the latest request). Re-stamped the same
  -- day only when a seat period has begun since the last stamp, so a person
  -- who used the app either side of a period boundary counts on both sides.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, seen_on),
  CONSTRAINT staff_seen_days_order CHECK (last_seen_at >= first_seen_at)
);

COMMENT ON TABLE public.staff_seen_days IS
  'One row per staff member per UTC day they used the app. Seat charges are counted from here (billable_seat_count). Written only by note_staff_seen(); never by a client directly.';

-- The count: one org, a window of time.
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

-- ── 2. THE SEAT PERIOD AN ORG IS IN NOW ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.org_seat_periods (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_seat_periods_order CHECK (period_end > period_start)
);

COMMENT ON TABLE public.org_seat_periods IS
  'The one-month seat period an org is in now. Written by the seat billing on the service role; read by note_staff_seen() so a sighting after a period boundary is recorded for the new period.';

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

-- ── 3. WHAT WAS CHARGED, ONCE PER PERIOD ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seat_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  -- period_close: a month closed mid-subscription (yearly plans);
  -- renewal: added to the renewal invoice; cancellation: the final period.
  reason text NOT NULL,
  -- claimed: being billed now. billed: on an invoice. nothing_to_bill: nobody
  -- past the allowance used it. failed: Stripe refused; the next run retries.
  status text NOT NULL DEFAULT 'claimed',
  seats_seen integer,
  included_seats integer,
  billed_seats integer,
  unit_amount_cents integer,
  amount_cents integer,
  currency text,
  stripe_invoice_item_id text,
  stripe_invoice_id text,
  error text,
  attempts integer NOT NULL DEFAULT 1,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  billed_at timestamptz,
  CONSTRAINT seat_charges_once UNIQUE (stripe_subscription_id, period_start),
  CONSTRAINT seat_charges_order CHECK (period_end > period_start),
  CONSTRAINT seat_charges_reason CHECK (reason IN ('period_close', 'renewal', 'cancellation')),
  CONSTRAINT seat_charges_status CHECK (status IN ('claimed', 'billed', 'nothing_to_bill', 'failed')),
  CONSTRAINT seat_charges_counts CHECK (
    (seats_seen IS NULL OR seats_seen >= 0)
    AND (billed_seats IS NULL OR billed_seats >= 0)
    AND (amount_cents IS NULL OR amount_cents >= 0)
  ),
  CONSTRAINT seat_charges_error_length CHECK (error IS NULL OR char_length(error) <= 1000)
);

COMMENT ON TABLE public.seat_charges IS
  'One row per subscription per seat period: the people counted and what was charged. UNIQUE (stripe_subscription_id, period_start) is what bills each period exactly once. Written by seat-charges.server.ts on the service role through claim_seat_charge().';

CREATE INDEX IF NOT EXISTS seat_charges_organization_id
  ON public.seat_charges (organization_id, period_start);

ALTER TABLE public.seat_charges ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.seat_charges');

REVOKE ALL ON public.seat_charges FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.seat_charges TO authenticated;
GRANT ALL ON public.seat_charges TO service_role;

DROP POLICY IF EXISTS "seat charges: owners and office managers (select)" ON public.seat_charges;
CREATE POLICY "seat charges: owners and office managers (select)" ON public.seat_charges
  FOR SELECT TO authenticated
  USING (
    public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
    OR public.has_role((SELECT auth.uid()), organization_id, 'office_manager'::public.app_role)
  );

-- ── 4. THE SIGHTING ───────────────────────────────────────────────────────
-- Returns what happened: { stamped: bool, why?: text, organization_id?: uuid }.
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
  _p_start timestamptz;
  _today_last timestamptz;
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

  SELECT p.period_start INTO _p_start
    FROM public.org_seat_periods p WHERE p.organization_id = _org_id;

  -- The throttle, read-only: already stamped today, and since the current
  -- seat period began. Ninety-nine calls in a hundred end here.
  SELECT d.last_seen_at INTO _today_last
    FROM public.staff_seen_days d WHERE d.staff_id = _staff_id AND d.seen_on = _today;
  IF _today_last IS NOT NULL AND (_p_start IS NULL OR _today_last >= _p_start) THEN
    RETURN jsonb_build_object('stamped', false, 'why', 'already_today', 'organization_id', _org_id);
  END IF;

  INSERT INTO public.staff_seen_days (organization_id, staff_id, seen_on)
  VALUES (_org_id, _staff_id, _today)
  ON CONFLICT (staff_id, seen_on) DO UPDATE SET last_seen_at = now();

  RETURN jsonb_build_object('stamped', true, 'organization_id', _org_id);
END;
$fn$;

COMMENT ON FUNCTION public.note_staff_seen() IS
  'Records that the CALLER used the app today (staff_seen_days). Refuses impersonation sessions, platform admins, password-only two-step sessions and inactive staff. At most one write per person per UTC day, plus one after a seat period boundary.';

REVOKE ALL ON FUNCTION public.note_staff_seen() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.note_staff_seen() TO authenticated;

-- ── 5. THE COUNT ──────────────────────────────────────────────────────────
-- Distinct people seen in the org in [_from, _to). A day's row is evidence of
-- use from its first stamp to its last, so it counts in every period that
-- span touches. Not filtered on staff.active, on purpose: somebody who worked
-- this period and left still worked this period.
CREATE OR REPLACE FUNCTION public.billable_seat_count(
  _org_id uuid,
  _from timestamptz,
  _to timestamptz DEFAULT 'infinity'
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT count(DISTINCT d.staff_id)::integer
    FROM public.staff_seen_days d
   WHERE d.organization_id = _org_id
     AND d.last_seen_at >= _from
     AND d.first_seen_at < _to;
$fn$;

COMMENT ON FUNCTION public.billable_seat_count(uuid, timestamptz, timestamptz) IS
  'People who used their login in the org in [_from, _to): the seat count a period is charged for. Service role only.';

REVOKE ALL ON FUNCTION public.billable_seat_count(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billable_seat_count(uuid, timestamptz, timestamptz) TO service_role;

-- ── 6. THE CLAIM ──────────────────────────────────────────────────────────
-- Claims one subscription's seat period for billing, BEFORE Stripe is called,
-- so two runs (the renewal webhook and the nightly sweep, say) cannot both
-- charge it. Returns { claimed: bool, id, status, retry: bool }:
--
--   new period                    -> claimed
--   failed earlier                -> claimed again (retry: true)
--   claimed > 30 min, < 23 h ago  -> claimed again (retry: true): the run that
--                                    claimed it died; the caller looks for its
--                                    invoice item in Stripe before making one,
--                                    and Stripe's 24 h idempotency covers the rest
--   anything else                 -> not claimed (billed, nothing to bill,
--                                    in progress, or stuck past 23 h for a person)
CREATE OR REPLACE FUNCTION public.claim_seat_charge(
  _org_id uuid,
  _subscription_id text,
  _period_start timestamptz,
  _period_end timestamptz,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _row public.seat_charges;
BEGIN
  INSERT INTO public.seat_charges (organization_id, stripe_subscription_id, period_start, period_end, reason)
  VALUES (_org_id, _subscription_id, _period_start, _period_end, _reason)
  ON CONFLICT (stripe_subscription_id, period_start) DO NOTHING
  RETURNING * INTO _row;
  IF _row.id IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', true, 'id', _row.id, 'status', 'claimed', 'retry', false);
  END IF;

  UPDATE public.seat_charges c
     SET status = 'claimed', claimed_at = now(), attempts = c.attempts + 1, error = NULL,
         -- A cancellation can end the final period early; never lengthen one.
         period_end = LEAST(c.period_end, _period_end)
   WHERE c.stripe_subscription_id = _subscription_id
     AND c.period_start = _period_start
     AND (
       c.status = 'failed'
       OR (c.status = 'claimed'
           AND c.claimed_at < now() - interval '30 minutes'
           AND c.claimed_at > now() - interval '23 hours')
     )
  RETURNING * INTO _row;
  IF _row.id IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', true, 'id', _row.id, 'status', 'claimed', 'retry', true);
  END IF;

  SELECT * INTO _row FROM public.seat_charges c
   WHERE c.stripe_subscription_id = _subscription_id AND c.period_start = _period_start;
  RETURN jsonb_build_object('claimed', false, 'id', _row.id, 'status', _row.status, 'retry', false);
END;
$fn$;

COMMENT ON FUNCTION public.claim_seat_charge(uuid, text, timestamptz, timestamptz, text) IS
  'Claims a subscription''s seat period for billing before Stripe is called, so it is charged exactly once. Service role only.';

REVOKE ALL ON FUNCTION public.claim_seat_charge(uuid, text, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_seat_charge(uuid, text, timestamptz, timestamptz, text) TO service_role;

-- ── 7. WHAT THIS FILE ESTABLISHES ─────────────────────────────────────────
DO $check$
DECLARE
  _t text;
  _f text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['staff_seen_days', 'org_seat_periods', 'seat_charges'] LOOP
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
    -- write somebody else's, or delete its own and drop off the bill; one that
    -- could write a charge row could mark a period billed that never was.
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.seat_charges'::regclass AND conname = 'seat_charges_once' AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'seat_charges has no (subscription, period) unique key, so a period could be charged twice';
  END IF;

  IF has_function_privilege('anon', 'public.note_staff_seen()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call note_staff_seen()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.note_staff_seen()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a signed-in user cannot record their own sighting';
  END IF;
  FOREACH _f IN ARRAY ARRAY[
    'public.billable_seat_count(uuid, timestamptz, timestamptz)',
    'public.claim_seat_charge(uuid, text, timestamptz, timestamptz, text)'
  ] LOOP
    IF has_function_privilege('authenticated', _f, 'EXECUTE')
       OR has_function_privilege('anon', _f, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable from the API; it is service role only', _f;
    END IF;
  END LOOP;
END
$check$;
