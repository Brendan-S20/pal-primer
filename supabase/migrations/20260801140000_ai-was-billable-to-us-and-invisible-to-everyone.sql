-- BUILD-2 — usage metering, soft caps, and overage. The schema half.
--
-- Every AI feature in this product runs on HoundStack's own API keys, and
-- nothing anywhere counted a single call. The receptionist answers inbound
-- texts and phone calls with no human in the loop; the weekly digest fires
-- from cron. Both spend our money, unattended, with no record that they did.
--
-- Two places already told this story and were ignored because there was
-- nothing to point at:
--
--   ai-credentials.server.ts   "orgId is kept in the signature deliberately.
--                               BUILD-2 needs a per-org hook exactly here"
--   BusinessAdvisor.tsx        "Uses part of your plan's AI allowance"
--
-- The second one is a UI string asserting a fact about the product that was
-- not true — there was no allowance and nothing was consumed. That is the
-- fourth time this cycle a written claim has been treated as a fact.
--
-- ── WHY THE PERIOD IS AN ORG-LOCAL CALENDAR MONTH ─────────────────────────
--
-- The obvious alternative is the subscription's own anniversary period, so the
-- overage lines up exactly with the invoice that carries it. Rejected:
--
--   * it depends on `organizations.current_period_end` being fresh, which is
--     maintained by a webhook. A period boundary that drifts when a webhook is
--     missed silently re-opens or re-closes a billing window, and the failure
--     is invisible until someone is billed twice;
--   * a trial or free org has no subscription at all, so the anniversary shape
--     has no answer for the accounts most likely to run up unattended spend;
--   * "your July AI usage" is a sentence a customer can check. "Your Jul 15 to
--     Aug 14 usage" is not.
--
-- Stripe does not require an invoice item's period to match the invoice's, so
-- a July overage lands on whatever invoice comes next, labelled with the month
-- it covers. The month is the org's OWN month — `organizations.timezone`, not
-- the server's — because a call at 9pm on 31 July in Chicago is July usage,
-- and the server's clock says August. Same rule as the due-date trigger, the
-- billing run and the settlement generator (20260801110000, 20260801111000).
--
-- ── WHY ONE ACTION IS ONE INVOCATION ──────────────────────────────────────
--
-- Not one round-trip. The receptionist runs up to six model steps to answer a
-- single text, and billing a customer six actions for one conversation is not
-- a sentence anyone can defend. Tokens and our real cost are recorded on the
-- event anyway, so if a feature turns out to cost more than it earns, the
-- answer is to change the allowance or that feature's own price — with
-- evidence — rather than to make the meter harder to explain.

-- ── plan allowances ────────────────────────────────────────────────────────
--
-- On the plan, not in code: the numbers are a pricing decision and must be
-- changeable with an UPDATE. NULL means unlimited, which is what Enterprise
-- gets — a negotiated contract is not a place for a hard-coded cap.
ALTER TABLE public.platform_plans
  ADD COLUMN IF NOT EXISTS ai_actions_included integer,
  ADD COLUMN IF NOT EXISTS ai_overage_cents_per_action integer;

COMMENT ON COLUMN public.platform_plans.ai_actions_included IS
  'BUILD-2: AI invocations included per org-local calendar month. NULL = unlimited (Enterprise). One invocation = one action regardless of how many model round-trips it takes internally.';
COMMENT ON COLUMN public.platform_plans.ai_overage_cents_per_action IS
  'BUILD-2: charged per action beyond ai_actions_included. NULL = no overage billed (usage is still metered and still subject to the hard ceiling).';

-- PROVISIONAL. Seeded so the feature is complete and observable end to end;
-- these are engineering defaults, not a priced offer, and nothing published
-- advertises an AI allowance yet. Change them here.
UPDATE public.platform_plans SET ai_actions_included = 200,  ai_overage_cents_per_action = 10 WHERE slug = 'launch';
UPDATE public.platform_plans SET ai_actions_included = 750,  ai_overage_cents_per_action = 10 WHERE slug = 'growth';
UPDATE public.platform_plans SET ai_actions_included = 2500, ai_overage_cents_per_action = 10 WHERE slug = 'scale';
UPDATE public.platform_plans SET ai_actions_included = NULL, ai_overage_cents_per_action = NULL WHERE slug = 'enterprise';

-- ── the org's own ceiling ──────────────────────────────────────────────────
--
-- The soft cap bills; this one STOPS. Without it "soft cap plus overage" has
-- no upper bound, and the unbounded case is not hypothetical: the receptionist
-- is triggered by inbound messages, so a loop between two automated systems
-- spends real money at machine speed with nobody watching.
--
-- Owner-adjustable, because the right ceiling for a business running a phone
-- campaign is not the right ceiling for one that never touches AI.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS ai_hard_cap_multiplier numeric(4,1) NOT NULL DEFAULT 3.0;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_ai_hard_cap_multiplier_sane;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_ai_hard_cap_multiplier_sane
  CHECK (ai_hard_cap_multiplier >= 1.0 AND ai_hard_cap_multiplier <= 100.0);

COMMENT ON COLUMN public.organizations.ai_hard_cap_multiplier IS
  'BUILD-2: AI refuses once the month''s actions reach this multiple of the plan allowance. >= 1.0, so it can never sit BELOW the allowance the org has already paid for.';

-- ── the event log ──────────────────────────────────────────────────────────
--
-- One row per invocation. Kept rather than only rolled up, because the first
-- question anyone asks about a surprising bill is "which feature", and a
-- counter cannot answer it.
CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- The org-local month this call belongs to, stamped at write time so the
  -- rollup can never disagree with the event about which month it was.
  period_month date NOT NULL,
  feature text NOT NULL,
  provider text NOT NULL,
  model text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  -- Our estimated provider cost, in millionths of a cent. Integer, because a
  -- float column for money is how a ledger stops adding up.
  cost_micros bigint NOT NULL DEFAULT 0,
  -- Almost always 1. A column rather than a COUNT(*) so a future feature that
  -- genuinely is worth more than one action can say so without a migration
  -- that rewrites history.
  actions integer NOT NULL DEFAULT 1 CHECK (actions >= 0),
  -- TRUE when the call was allowed to proceed past the allowance. Recorded on
  -- the event, so "why am I being charged for this" is answerable per call.
  over_allowance boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_events_org_month_idx
  ON public.ai_usage_events (organization_id, period_month);
CREATE INDEX IF NOT EXISTS ai_usage_events_org_time_idx
  ON public.ai_usage_events (organization_id, occurred_at DESC);

-- ── the rollup ─────────────────────────────────────────────────────────────
--
-- Every AI call has to know the month's total before it runs. Summing the
-- event log on the request path would make the meter the slowest part of the
-- feature it meters, so the total is maintained here.
CREATE TABLE IF NOT EXISTS public.ai_usage_periods (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_month date NOT NULL,
  actions integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  -- Billing state for this closed month. Set once, by the overage run.
  billed_at timestamptz,
  billed_actions integer,
  billed_cents integer,
  stripe_invoice_item_id text,
  -- The 80% warning, so it is filed once and not on every call after.
  warned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, period_month)
);

CREATE INDEX IF NOT EXISTS ai_usage_periods_unbilled_idx
  ON public.ai_usage_periods (period_month)
  WHERE billed_at IS NULL;

-- ── the rollup is RECOUNTED, never incremented ─────────────────────────────
--
-- The credit-balance drift (BUG-81, 20260801100000) was a maintained total
-- that added deltas: every writer that forgot to call it, and every partial
-- failure, left the total permanently wrong with nothing to detect it. A
-- recount from the rows is O(month) on a small table and cannot drift by
-- construction — the same fix applied there, applied here before it can
-- happen rather than after.
CREATE OR REPLACE FUNCTION public.tg_ai_usage_rollup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _org uuid;
  _month date;
BEGIN
  FOR _org, _month IN
    SELECT DISTINCT o, m FROM unnest(
      ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.organization_id END,
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.organization_id END],
      ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.period_month END,
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.period_month END]
    ) AS t(o, m)
    WHERE o IS NOT NULL AND m IS NOT NULL
  LOOP
    INSERT INTO public.ai_usage_periods AS p
      (organization_id, period_month, actions, input_tokens, output_tokens, cost_micros, updated_at)
    SELECT _org, _month,
           COALESCE(sum(e.actions), 0),
           COALESCE(sum(e.input_tokens), 0),
           COALESCE(sum(e.output_tokens), 0),
           COALESCE(sum(e.cost_micros), 0),
           now()
      FROM public.ai_usage_events e
     WHERE e.organization_id = _org AND e.period_month = _month
    ON CONFLICT (organization_id, period_month) DO UPDATE
      SET actions       = EXCLUDED.actions,
          input_tokens  = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cost_micros   = EXCLUDED.cost_micros,
          updated_at    = now();
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ai_usage_rollup ON public.ai_usage_events;
CREATE TRIGGER ai_usage_rollup
  AFTER INSERT OR UPDATE OR DELETE ON public.ai_usage_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_ai_usage_rollup();

-- ── RLS ────────────────────────────────────────────────────────────────────
--
-- Both tables are READ-ONLY to every tenant role. The only writer is the
-- service role recording a call it just made; a tenant who could insert here
-- could not raise their own bill, but a tenant who could DELETE could erase
-- the evidence of their own overage — which is the whole record of what we are
-- owed. Nine tables in v1.14 were open because the server function was treated
-- as the only gate (BUG-80); this one starts closed.
ALTER TABLE public.ai_usage_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_usage_events_read ON public.ai_usage_events;
CREATE POLICY ai_usage_events_read ON public.ai_usage_events
  FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_org_billing'));

DROP POLICY IF EXISTS ai_usage_periods_read ON public.ai_usage_periods;
CREATE POLICY ai_usage_periods_read ON public.ai_usage_periods
  FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_org_billing'));

REVOKE ALL ON public.ai_usage_events  FROM anon;
REVOKE ALL ON public.ai_usage_periods FROM anon;
GRANT SELECT ON public.ai_usage_events  TO authenticated;
GRANT SELECT ON public.ai_usage_periods TO authenticated;

COMMENT ON TABLE public.ai_usage_events IS
  'BUILD-2: one row per AI invocation, attributed to an org and an org-local month. Read-only to tenants (manage_org_billing); written only by the service role. Feeds ai_usage_periods by recount trigger.';
COMMENT ON TABLE public.ai_usage_periods IS
  'BUILD-2: per-org, per-month AI totals, RECOUNTED from ai_usage_events rather than incremented (see BUG-81). Carries the billing state for the month''s overage and the 80% warning stamp.';

-- ── the cap decision, in SQL ───────────────────────────────────────────────
--
-- One round trip on the AI request path, and one definition of the rule. The
-- TypeScript reads this rather than re-deriving it, because "one fact, two
-- implementations" is what this ledger has spent the whole cycle deleting.
CREATE OR REPLACE FUNCTION public.ai_usage_state(_org_id uuid)
RETURNS TABLE (
  period_month date,
  actions_used integer,
  actions_included integer,
  overage_cents_per_action integer,
  hard_cap_actions integer,
  over_allowance boolean,
  over_hard_cap boolean,
  overage_cents integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _tz text;
  _month date;
  _used integer;
  _included integer;
  _rate integer;
  _mult numeric;
  _hard integer;
BEGIN
  SELECT COALESCE(o.timezone, 'America/Chicago'), o.ai_hard_cap_multiplier
    INTO _tz, _mult
    FROM public.organizations o WHERE o.id = _org_id;
  IF _tz IS NULL THEN RETURN; END IF;

  -- The org's own month, not the server's.
  _month := date_trunc('month', (now() AT TIME ZONE _tz))::date;

  SELECT COALESCE(p.actions, 0) INTO _used
    FROM public.ai_usage_periods p
   WHERE p.organization_id = _org_id AND p.period_month = _month;
  _used := COALESCE(_used, 0);

  SELECT pp.ai_actions_included, pp.ai_overage_cents_per_action
    INTO _included, _rate
    FROM public.organizations o
    JOIN public.platform_plans pp ON pp.id = o.plan_id
   WHERE o.id = _org_id;

  -- No plan, or a plan with no allowance set, is NOT unlimited-by-accident.
  -- An org on no plan reaching this function is a trial or a misconfiguration,
  -- and the gate above this one (checkAiAccess) already decides whether they
  -- may use AI at all. What it must not do is hand them an unbounded budget,
  -- so an unknown plan gets the smallest allowance in the catalog.
  IF _included IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.organizations o
      JOIN public.platform_plans pp ON pp.id = o.plan_id
     WHERE o.id = _org_id AND pp.ai_actions_included IS NULL
  ) THEN
    SELECT min(pp.ai_actions_included) INTO _included
      FROM public.platform_plans pp
     WHERE pp.is_active AND pp.ai_actions_included IS NOT NULL;
  END IF;

  _hard := CASE WHEN _included IS NULL THEN NULL
                ELSE ceil(_included * COALESCE(_mult, 3.0))::integer END;

  RETURN QUERY SELECT
    _month,
    _used,
    _included,
    _rate,
    _hard,
    (_included IS NOT NULL AND _used >= _included),
    (_hard IS NOT NULL AND _used >= _hard),
    CASE WHEN _included IS NULL OR _rate IS NULL OR _used <= _included THEN 0
         ELSE (_used - _included) * _rate END;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_usage_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_usage_state(uuid) TO service_role;
-- Readable by the people who can see the bill, so Settings can show it without
-- a server round trip that re-derives the same numbers a third way.
GRANT EXECUTE ON FUNCTION public.ai_usage_state(uuid) TO authenticated;

COMMENT ON FUNCTION public.ai_usage_state(uuid) IS
  'BUILD-2: the one definition of where an org stands against its AI allowance this org-local month — used, included, the hard ceiling, and the overage owed. Called on the AI request path and by Settings. An org with no plan gets the catalog''s smallest allowance, never unlimited.';

-- ── prove it ───────────────────────────────────────────────────────────────
--
-- The checks write a real organization and 750 usage events, so they run in a
-- SUBTRANSACTION that is always rolled back: the inner block ends by raising a
-- marker, and the handler swallows only that marker. A genuine failure
-- re-raises and takes the migration down with it, which is the point — a
-- verification block that cannot fail the thing it verifies is decoration.
DO $$
DECLARE
  _org uuid;
  _plan uuid;
  _month date;
  _r record;
BEGIN
 BEGIN
  SELECT id INTO _plan FROM public.platform_plans WHERE slug = 'launch';
  IF _plan IS NULL THEN RAISE EXCEPTION 'no launch plan to test against'; END IF;

  INSERT INTO public.organizations (name, timezone, plan_id)
  VALUES ('BUILD-2 verification', 'America/Chicago', _plan)
  RETURNING id INTO _org;

  _month := date_trunc('month', (now() AT TIME ZONE 'America/Chicago'))::date;

  -- Nothing used: not over anything, nothing owed.
  SELECT * INTO _r FROM public.ai_usage_state(_org);
  IF _r.actions_used <> 0 OR _r.over_allowance OR _r.over_hard_cap OR _r.overage_cents <> 0 THEN
    RAISE EXCEPTION 'fresh org is already over: used=% over=% hard=% owed=%',
      _r.actions_used, _r.over_allowance, _r.over_hard_cap, _r.overage_cents;
  END IF;
  IF _r.actions_included <> 200 OR _r.hard_cap_actions <> 600 THEN
    RAISE EXCEPTION 'allowance/ceiling wrong: included=% hard=%',
      _r.actions_included, _r.hard_cap_actions;
  END IF;

  -- The rollup must exist and be right without anyone maintaining it.
  INSERT INTO public.ai_usage_events (organization_id, period_month, feature, provider, actions, input_tokens)
  SELECT _org, _month, 'verification', 'test', 1, 10 FROM generate_series(1, 250);

  SELECT * INTO _r FROM public.ai_usage_state(_org);
  IF _r.actions_used <> 250 THEN
    RAISE EXCEPTION 'rollup did not recount: %', _r.actions_used;
  END IF;
  IF NOT _r.over_allowance OR _r.over_hard_cap THEN
    RAISE EXCEPTION '250 of 200 should be over the allowance and under the ceiling: over=% hard=%',
      _r.over_allowance, _r.over_hard_cap;
  END IF;
  IF _r.overage_cents <> 500 THEN  -- 50 actions * 10c
    RAISE EXCEPTION 'overage should be 500c, got %', _r.overage_cents;
  END IF;

  -- Deleting events must move the total back down, or the recount is a lie.
  DELETE FROM public.ai_usage_events
   WHERE id IN (SELECT id FROM public.ai_usage_events
                 WHERE organization_id = _org LIMIT 100);
  SELECT * INTO _r FROM public.ai_usage_state(_org);
  IF _r.actions_used <> 150 OR _r.over_allowance THEN
    RAISE EXCEPTION 'recount did not fall after delete: used=% over=%',
      _r.actions_used, _r.over_allowance;
  END IF;

  -- The ceiling.
  INSERT INTO public.ai_usage_events (organization_id, period_month, feature, provider, actions)
  SELECT _org, _month, 'verification', 'test', 1 FROM generate_series(1, 500);
  SELECT * INTO _r FROM public.ai_usage_state(_org);
  IF NOT _r.over_hard_cap THEN
    RAISE EXCEPTION '650 of a 600 ceiling should be over it: used=%', _r.actions_used;
  END IF;

  RAISE EXCEPTION 'BUILD2_VERIFY_ROLLBACK';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'BUILD2_VERIFY_ROLLBACK' THEN RAISE; END IF;
 END;
 RAISE NOTICE 'BUILD-2 verified: allowance, recount, overage and ceiling all behave; test data rolled back';
END $$;
