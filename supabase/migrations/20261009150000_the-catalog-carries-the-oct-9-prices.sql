-- The catalog carries the Oct 9 prices (owner, 2026-10-09; spec NP-1, NP-3,
-- NP-4, NP-8, NP-10, A-P0-2, A-P1-7).
--
-- ── PLANS ─────────────────────────────────────────────────────────────────
--
-- Every enabled user counts (`staff.active`). Each plan now covers a team-size
-- RANGE and includes fewer people:
--
--   plan     included  max team  extra person
--   Launch   1         3         $15/mo ($150/yr: the app bills seats x10)
--   Growth   5         15        $15/mo
--   Scale    20        none      $15/mo
--
-- Base and yearly prices are unchanged. `max_team_size` is new; NULL means no
-- cap. Minimums are not stored: a small team may choose a bigger plan.
--
-- ── WHY THE TIER FUNCTION CHANGES TOO ─────────────────────────────────────
--
-- `assign_billing_tier_for_org` gives an org that is NOT paying (a trial, a
-- lapsed account) "the cheapest active plan whose included_seats covers the
-- org". With 3/10/30 that was also the right range. With 1/5/20 it is not: a
-- two-person trial would be put on Growth (5 included) and handed Growth's
-- features, when Launch covers up to 3. So the function now asks the question
-- the new catalog answers, "the smallest plan whose team-size range holds this
-- many people", with NULL as unbounded. A paying org is unaffected: its tier
-- has always come from its subscription's plan.
--
-- ── ADD-ONS ───────────────────────────────────────────────────────────────
--
--   priority-support   $29 -> $99/mo; A-P1-7's description. Launch-only is
--                      enforced in code (src/lib/addon-launch.ts).
--   developer-setup    $499 -> $199 one time.
--   ai-receptionist    $49 -> $99/mo; stays `coming_soon` (not purchasable).
--   managed-sms        A-P0-2's description, exactly. Stays `coming_soon`.
--
-- ── WHAT THIS DOES NOT TOUCH ──────────────────────────────────────────────
--
-- No subscription, no `org_platform_addons` row, no organization. Existing
-- subscriptions are grandfathered: they renew at the Stripe price they are on,
-- which this file cannot see and does not change. These rows govern NEW
-- purchases only. The stored Stripe price ids are also left alone: the app
-- resolves prices by lookup key first, so the B3 step that creates the new
-- live prices must move the lookup keys to them (and may repoint these ids).
--
-- Replays into an empty database: every row is updated by slug, a missing row
-- is warned about rather than failed, and no row count is asserted.

ALTER TABLE public.platform_plans
  ADD COLUMN IF NOT EXISTS max_team_size integer;

COMMENT ON COLUMN public.platform_plans.max_team_size IS
  'The most enabled users (staff.active) an account on this plan may have. '
  'NULL = no cap. Enforced on enabling or inviting a user and on choosing a plan.';

ALTER TABLE public.platform_plans
  DROP CONSTRAINT IF EXISTS platform_plans_max_team_size_positive;
ALTER TABLE public.platform_plans
  ADD CONSTRAINT platform_plans_max_team_size_positive
  CHECK (max_team_size IS NULL OR max_team_size >= 1);

ALTER TABLE public.platform_plans
  DROP CONSTRAINT IF EXISTS platform_plans_included_within_max;
ALTER TABLE public.platform_plans
  ADD CONSTRAINT platform_plans_included_within_max
  CHECK (max_team_size IS NULL OR included_seats IS NULL OR included_seats <= max_team_size);

UPDATE public.platform_plans
   SET included_seats = v.included,
       max_team_size = v.max_team,
       price_per_seat_cents = 1500,
       updated_at = now()
  FROM (VALUES
          ('launch', 1, 3),
          ('growth', 5, 15),
          ('scale', 20, NULL::integer)
       ) AS v(slug, included, max_team)
 WHERE platform_plans.slug = v.slug;

CREATE OR REPLACE FUNCTION public.assign_billing_tier_for_org(_org_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _seats integer;
  _status text;
  _plan public.platform_plans;
  _sub_slug text;
BEGIN
  SELECT active_seat_count, billing_status::text
    INTO _seats, _status
    FROM public.organizations WHERE id = _org_id;
  IF _seats IS NULL THEN RETURN NULL; END IF;

  -- Paying tenants are governed by their subscription, not seat count. WRITE the
  -- subscribed plan's slug to billing_tier (only if it drifted) so a plan switch
  -- can't leave a stale tier. Never touch plan_id here (avoids re-firing the
  -- plan_id-change trigger below).
  IF _status IN ('active', 'grace', 'past_due') THEN
    SELECT p.slug INTO _sub_slug
      FROM public.platform_plans p
      JOIN public.organizations o ON o.plan_id = p.id
     WHERE o.id = _org_id;
    IF _sub_slug IS NOT NULL THEN
      UPDATE public.organizations
         SET billing_tier = _sub_slug
       WHERE id = _org_id AND billing_tier IS DISTINCT FROM _sub_slug;
    END IF;
    RETURN _sub_slug;
  END IF;

  -- The smallest plan whose team-size range holds this many people. NULL
  -- max_team_size is unbounded. (Until 2026-10-09 this compared included_seats,
  -- which was the range when a plan included its whole range; it no longer is.)
  SELECT * INTO _plan
  FROM public.platform_plans
  WHERE is_active = true AND is_enterprise = false AND included_seats IS NOT NULL
    AND (max_team_size IS NULL OR max_team_size >= GREATEST(_seats, 1))
  ORDER BY max_team_size ASC NULLS LAST, included_seats ASC, sort_order ASC
  LIMIT 1;

  IF _plan.id IS NULL THEN
    SELECT * INTO _plan
    FROM public.platform_plans
    WHERE is_active = true AND is_enterprise = false AND included_seats IS NOT NULL
    ORDER BY max_team_size DESC NULLS FIRST, included_seats DESC, sort_order DESC
    LIMIT 1;
  END IF;

  IF _plan.id IS NOT NULL THEN
    UPDATE public.organizations
       SET billing_tier = _plan.slug,
           plan_id = _plan.id
     WHERE id = _org_id
       AND (billing_tier IS DISTINCT FROM _plan.slug OR plan_id IS DISTINCT FROM _plan.id);
  END IF;
  RETURN _plan.slug;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_billing_tier_for_org(uuid) FROM PUBLIC, anon, authenticated;

UPDATE public.platform_addons
   SET price_cents = 9900,
       description = 'Faster email support, with a reply the same business day.',
       updated_at = now()
 WHERE slug = 'priority-support';

UPDATE public.platform_addons
   SET price_cents = 19900,
       updated_at = now()
 WHERE slug = 'developer-setup';

UPDATE public.platform_addons
   SET price_cents = 9900,
       updated_at = now()
 WHERE slug = 'ai-receptionist';

UPDATE public.platform_addons
   SET description =
         'Coming soon. Two-way texting with your clients from your own local number, '
         'registered with carriers under your business name. HoundStack handles the setup '
         'and carrier filing for you, with consent and STOP handling built in. We''ll need '
         'your business details and approval before registering. No Twilio account of your '
         'own required.',
       updated_at = now()
 WHERE slug = 'managed-sms';

DO $check$
DECLARE
  _p record;
  _a record;
  _seen int := 0;
BEGIN
  -- Established from any starting state: the column and its rules exist.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'platform_plans' AND column_name = 'max_team_size'
  ) THEN
    RAISE EXCEPTION 'platform_plans.max_team_size was not created';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.assign_billing_tier_for_org(uuid)'::regprocedure)
     !~ 'max_team_size' THEN
    RAISE EXCEPTION 'assign_billing_tier_for_org still sizes a plan by included_seats alone';
  END IF;
  IF has_function_privilege('authenticated', 'public.assign_billing_tier_for_org(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'assign_billing_tier_for_org is callable by authenticated';
  END IF;

  -- The rows, where they exist. A fresh build has none; that is a warning.
  FOR _p IN
    SELECT v.slug AS want_slug, v.included AS want_inc, v.max_team AS want_max,
           p.id, p.included_seats, p.max_team_size, p.price_per_seat_cents
      FROM (VALUES ('launch', 1, 3), ('growth', 5, 15), ('scale', 20, NULL::integer)) AS v(slug, included, max_team)
      LEFT JOIN public.platform_plans p ON p.slug = v.slug
  LOOP
    IF _p.id IS NULL THEN
      RAISE WARNING 'no % plan on this database; nothing to update for it', _p.want_slug;
      CONTINUE;
    END IF;
    _seen := _seen + 1;
    IF _p.included_seats IS DISTINCT FROM _p.want_inc
       OR _p.max_team_size IS DISTINCT FROM _p.want_max
       OR _p.price_per_seat_cents IS DISTINCT FROM 1500 THEN
      RAISE EXCEPTION 'plan % did not take the new numbers (included %, max %, seat %)',
        _p.want_slug, _p.included_seats, _p.max_team_size, _p.price_per_seat_cents;
    END IF;
  END LOOP;
  RAISE NOTICE 'plans updated: % of 3 present', _seen;

  FOR _a IN
    SELECT v.slug, v.cents, a.price_cents, a.status, a.description, a.id
      FROM (VALUES ('priority-support', 9900), ('developer-setup', 19900),
                   ('ai-receptionist', 9900), ('managed-sms', NULL::integer)) AS v(slug, cents)
      LEFT JOIN public.platform_addons a ON a.slug = v.slug
  LOOP
    IF _a.id IS NULL THEN
      RAISE WARNING 'no % add-on on this database; nothing to update for it', _a.slug;
      CONTINUE;
    END IF;
    IF _a.cents IS NOT NULL AND _a.price_cents IS DISTINCT FROM _a.cents THEN
      RAISE EXCEPTION '% is % cents, expected %', _a.slug, _a.price_cents, _a.cents;
    END IF;
    -- The two texting add-ons stay off sale whatever their price says.
    IF _a.slug IN ('ai-receptionist', 'managed-sms') AND _a.status = 'active' THEN
      RAISE EXCEPTION '% is purchasable; it must stay coming soon', _a.slug;
    END IF;
    IF _a.slug = 'priority-support' AND _a.description ~* '(phone|chat|direct support channel)' THEN
      RAISE EXCEPTION 'priority support still promises phone or chat';
    END IF;
    IF _a.slug = 'managed-sms' AND _a.description !~ '^Coming soon\. ' THEN
      RAISE EXCEPTION 'managed texting description does not lead with "Coming soon."';
    END IF;
  END LOOP;
END
$check$;
