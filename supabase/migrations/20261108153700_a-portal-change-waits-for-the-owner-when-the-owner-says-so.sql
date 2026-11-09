-- A portal change waits for the owner, when the owner says so (#730; audit
-- F-18, F-21, R2-41; decision D6 option C).
--
-- PROPOSED MIGRATION. Not applied to any live database by the change that
-- adds it.
--
-- WHAT WAS WRONG. A customer who pressed Reschedule or Skip in the portal
-- changed the schedule the moment they pressed it: portal_reschedule_visit
-- moved the visit and unassigned it, portal_request_skip skipped it. There was
-- no way for the business to say "ask me first", the office Requests page
-- never saw the change, and there was no rule for a change made late beyond
-- one hard cutoff for every service the business runs.
--
-- THE DECISION (Brendan, 2026-11-08, verbatim): "owner approval queue, cutoff
-- rules, fees charged automatically through Stripe", and then "The tenant, or
-- business owner needs to have a way to choose."
--
-- So:
--
-- 1. organizations.portal_change_policy, 'instant' or 'approval'. The OWNER
--    chooses. 'instant' is what every business has today; 'approval' sends a
--    reschedule or a cancel to a queue the owner approves or denies.
--      * Every business that exists when this runs keeps 'instant': the
--        column is added with that default, which fills every existing row,
--        and only THEN is the default changed.
--      * A business created afterwards starts on 'approval'. That is the
--        coordinator's recommendation for D6, not an owner decision about any
--        particular business, and the owner can change it in Settings.
--      * Nothing already applied is touched: no visit is read or written.
--
-- 2. public.portal_change_rules: per service line, a cutoff (NULL = the
--    business's existing portal_reschedule_cutoff_hours, so a business that
--    sets nothing sees no change), and a LATE window with a flat fee for a
--    late reschedule and a late cancel. Every fee defaults to 0 and the late
--    window to NULL: no row, no fee. Amounts are the owner's to type; none is
--    invented here.
--
--    "Late" means: asked for after (the visit day's local midnight minus
--    late_window_hours) but before the hard cutoff. Past the hard cutoff the
--    portal still refuses, exactly as it does today.
--
-- 3. public.portal_change_requests: every portal reschedule and cancel, in
--    either mode, with the fee the server computed and the fee the portal
--    showed. A request carries the fee the customer accepted; if the server's
--    figure differs (the owner changed it between page load and press) the
--    request is refused rather than charged at a figure nobody saw.
--
-- 4. public.portal_change_fee_charges and portal_change_fee_events: the fee,
--    once a change is applied (instantly, or on approval), and the Stripe
--    events that settle it. One charge per request (UNIQUE), one idempotency
--    key per charge, and every webhook event id recorded once, so a duplicate
--    delivery changes nothing. Charging is OFF unless the owner turns on
--    organizations.portal_change_fees_autocharge (default false) AND the
--    server is configured for Stripe test mode; see
--    src/lib/portal-change-fees.server.ts. With charging off the fee is
--    recorded as not charged, for the office to collect another way.
--
-- 5. Owner only, enforced here and not only on screen. The two organization
--    columns are guarded by a trigger (an office manager's PATCH of
--    /rest/v1/organizations is refused), the rules table has no write policy
--    at all (set_portal_change_settings is the only way in, and it asks for an
--    owner), and decide_portal_change_request asks for an owner of the
--    request's own business.
--
-- 6. Audit. activity_log rows for: a request, an instant apply, an approval,
--    a denial, a customer withdrawing a request, a fee charged / failed / not
--    charged, and every change to the policy, the auto-charge switch or the
--    rules, each naming who.
--
-- portal_reschedule_visit and portal_request_skip are NOT edited. The server
-- functions stop calling them and call portal_request_visit_change instead,
-- whose instant path applies the same writes those two make.
--
-- Replays into an empty database: columns, tables, functions, triggers,
-- policies and grants, then assertions about what this file creates. No rows
-- are read or written.

-- ── 1. The owner's choice ─────────────────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS portal_change_policy text NOT NULL DEFAULT 'instant';
-- Existing rows now hold 'instant'. New businesses start on approval.
ALTER TABLE public.organizations ALTER COLUMN portal_change_policy SET DEFAULT 'approval';

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'organizations_portal_change_policy_check'
                    AND conrelid = 'public.organizations'::regclass) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_portal_change_policy_check
      CHECK (portal_change_policy IN ('instant', 'approval'));
  END IF;
END
$c$;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS portal_change_fees_autocharge boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.portal_change_policy IS
  'What happens when a customer reschedules or cancels a visit from the portal: instant (applied at once, the behaviour before 20261108153700) or approval (waits in the owner''s queue). Existing businesses kept instant; new businesses default to approval. Only an owner changes it (tg_orgs_portal_change_owner_only).';
COMMENT ON COLUMN public.organizations.portal_change_fees_autocharge IS
  'Whether a late-change fee is charged to the customer''s saved card automatically. Off by default. Only an owner changes it. The server also refuses to charge unless it is configured for Stripe test mode (src/lib/portal-change-fees.server.ts).';

-- ── 2. Per-line cutoffs and late fees ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.portal_change_rules (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  service_line text NOT NULL,
  cutoff_hours integer,
  late_window_hours integer,
  late_reschedule_fee_cents integer NOT NULL DEFAULT 0,
  late_cancel_fee_cents integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (organization_id, service_line),
  CONSTRAINT portal_change_rules_line_check CHECK (
    service_line IN ('pet_waste', 'dog_walking', 'pet_sitting', 'mobile_grooming', 'training', 'other')),
  CONSTRAINT portal_change_rules_cutoff_check CHECK (cutoff_hours IS NULL OR cutoff_hours BETWEEN 0 AND 336),
  CONSTRAINT portal_change_rules_window_check CHECK (late_window_hours IS NULL OR late_window_hours BETWEEN 0 AND 336),
  -- A sanity bound, not a price: $1,000.
  CONSTRAINT portal_change_rules_fees_check CHECK (
    late_reschedule_fee_cents BETWEEN 0 AND 100000 AND late_cancel_fee_cents BETWEEN 0 AND 100000)
);

COMMENT ON TABLE public.portal_change_rules IS
  'Per service line: the portal change cutoff (NULL = organizations.portal_reschedule_cutoff_hours) and a late window with flat fees for a late reschedule or cancel. No row, or zeros, means no fee. Written only by set_portal_change_settings (owner only).';

ALTER TABLE public.portal_change_rules ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.portal_change_rules');

DROP POLICY IF EXISTS "Members read their portal change rules" ON public.portal_change_rules;
CREATE POLICY "Members read their portal change rules" ON public.portal_change_rules
  FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));

REVOKE ALL ON public.portal_change_rules FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.portal_change_rules FROM authenticated;
-- Explicit, rather than leaning on the schema's default privileges.
GRANT SELECT ON public.portal_change_rules TO authenticated;
GRANT ALL ON public.portal_change_rules TO service_role;

-- ── 3. The requests ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.portal_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  kind text NOT NULL,
  original_date date NOT NULL,
  requested_date date,
  reason text,
  policy text NOT NULL,
  status text NOT NULL,
  service_line text NOT NULL,
  late boolean NOT NULL DEFAULT false,
  fee_cents integer NOT NULL DEFAULT 0,
  fee_disclosed_cents integer,
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  -- One per press of a confirm button, made by the portal. A retried or
  -- double-tapped submission carries the same key and gets the first
  -- answer back instead of a second request (and a second fee).
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_change_requests_key_len CHECK (
    idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 100),
  CONSTRAINT portal_change_requests_kind_check CHECK (kind IN ('reschedule', 'cancel')),
  CONSTRAINT portal_change_requests_policy_check CHECK (policy IN ('instant', 'approval')),
  CONSTRAINT portal_change_requests_status_check CHECK (
    status IN ('pending', 'approved', 'denied', 'withdrawn', 'applied')),
  CONSTRAINT portal_change_requests_date_check CHECK ((kind = 'reschedule') = (requested_date IS NOT NULL)),
  CONSTRAINT portal_change_requests_fee_check CHECK (fee_cents >= 0),
  CONSTRAINT portal_change_requests_reason_len CHECK (reason IS NULL OR length(reason) <= 500),
  CONSTRAINT portal_change_requests_note_len CHECK (decision_note IS NULL OR length(decision_note) <= 500)
);

-- One open question per visit at a time.
CREATE UNIQUE INDEX IF NOT EXISTS portal_change_requests_one_pending_per_visit
  ON public.portal_change_requests (visit_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS portal_change_requests_one_per_key
  ON public.portal_change_requests (client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS portal_change_requests_org_status
  ON public.portal_change_requests (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_change_requests_client
  ON public.portal_change_requests (client_id);

COMMENT ON TABLE public.portal_change_requests IS
  'Every customer reschedule or cancel from the portal (#730). status pending waits for an owner (policy approval); applied went through at once (policy instant). Written only by the portal_* and decide_portal_change_request functions.';

ALTER TABLE public.portal_change_requests ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.portal_change_requests');

DROP POLICY IF EXISTS "Staff who see clients read portal change requests" ON public.portal_change_requests;
CREATE POLICY "Staff who see clients read portal change requests" ON public.portal_change_requests
  FOR SELECT TO authenticated
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'view_client_directory'));

REVOKE ALL ON public.portal_change_requests FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.portal_change_requests FROM authenticated;
-- Explicit, rather than leaning on the schema's default privileges.
GRANT SELECT ON public.portal_change_requests TO authenticated;
GRANT ALL ON public.portal_change_requests TO service_role;

-- ── 4. Fees and the events that settle them ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.portal_change_fee_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  request_id uuid NOT NULL UNIQUE REFERENCES public.portal_change_requests(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'pending',
  not_charged_reason text,
  idempotency_key text NOT NULL UNIQUE,
  stripe_payment_intent_id text UNIQUE,
  stripe_account_id text,
  failure_message text,
  livemode boolean,
  last_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_change_fee_charges_amount_check CHECK (amount_cents > 0),
  CONSTRAINT portal_change_fee_charges_status_check CHECK (
    status IN ('pending', 'not_charged', 'processing', 'requires_action', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS portal_change_fee_charges_org
  ON public.portal_change_fee_charges (organization_id, created_at DESC);

COMMENT ON TABLE public.portal_change_fee_charges IS
  'One late-change fee per portal change request. The amount is copied from the request, which the server computed; a client never supplies it. status succeeded/failed is set only by a verified Stripe webhook (record_portal_change_fee_event).';

ALTER TABLE public.portal_change_fee_charges ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.portal_change_fee_charges');

DROP POLICY IF EXISTS "Staff who see financials read portal change fees" ON public.portal_change_fee_charges;
CREATE POLICY "Staff who see financials read portal change fees" ON public.portal_change_fee_charges
  FOR SELECT TO authenticated
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'view_financials'));

REVOKE ALL ON public.portal_change_fee_charges FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.portal_change_fee_charges FROM authenticated;
-- Explicit, rather than leaning on the schema's default privileges.
GRANT SELECT ON public.portal_change_fee_charges TO authenticated;
GRANT ALL ON public.portal_change_fee_charges TO service_role;

CREATE TABLE IF NOT EXISTS public.portal_change_fee_events (
  event_id text PRIMARY KEY,
  charge_id uuid REFERENCES public.portal_change_fee_charges(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.portal_change_fee_events IS
  'Each Stripe event id that settled a portal change fee, recorded once. A second delivery of the same event finds its id here and changes nothing.';

ALTER TABLE public.portal_change_fee_events ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.portal_change_fee_events');
-- No permissive policy: only the service role (the webhook) reads or writes it.
REVOKE ALL ON public.portal_change_fee_events FROM anon, authenticated;
GRANT ALL ON public.portal_change_fee_events TO service_role;

-- ── 5. The rules, in one place ────────────────────────────────────────────

-- The service line a visit belongs to. A visit with no service of its own
-- reads its plan's; one with neither is pet waste, the column's default
-- everywhere else (serviceLinesOrDefault).
CREATE OR REPLACE FUNCTION public.portal_visit_service_line(_visit_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(vs.service_line, ss.service_line, 'pet_waste')
    FROM public.visits v
    LEFT JOIN public.services vs ON vs.id = v.service_id
    LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
    LEFT JOIN public.services ss ON ss.id = s.service_id
   WHERE v.id = _visit_id
$function$;

REVOKE ALL ON FUNCTION public.portal_visit_service_line(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_visit_service_line(uuid) TO service_role;

-- What a change to this visit costs and when it closes, read with the
-- business's own settings. The single definition: the request function and
-- the portal's list both call it.
CREATE OR REPLACE FUNCTION public.portal_change_terms(_visit_id uuid)
 RETURNS TABLE(
   organization_id uuid,
   service_line text,
   policy text,
   cutoff_at timestamptz,
   late_from timestamptz,
   reschedule_fee_cents integer,
   cancel_fee_cents integer
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT o.id,
         l.line,
         o.portal_change_policy,
         public.portal_change_deadline(v.scheduled_on, o.timezone,
           COALESCE(r.cutoff_hours, o.portal_reschedule_cutoff_hours)),
         CASE WHEN COALESCE(r.late_window_hours, 0) > 0
              THEN public.portal_change_deadline(v.scheduled_on, o.timezone, r.late_window_hours)
         END,
         CASE WHEN COALESCE(r.late_window_hours, 0) > 0 THEN COALESCE(r.late_reschedule_fee_cents, 0) ELSE 0 END,
         CASE WHEN COALESCE(r.late_window_hours, 0) > 0 THEN COALESCE(r.late_cancel_fee_cents, 0) ELSE 0 END
    FROM public.visits v
    JOIN public.organizations o ON o.id = v.organization_id
    CROSS JOIN LATERAL (SELECT public.portal_visit_service_line(v.id) AS line) l
    LEFT JOIN public.portal_change_rules r
           ON r.organization_id = o.id AND r.service_line = l.line
   WHERE v.id = _visit_id
$function$;

REVOKE ALL ON FUNCTION public.portal_change_terms(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_change_terms(uuid) TO service_role;

-- The fee a change made NOW would carry: zero before the late window opens.
CREATE OR REPLACE FUNCTION public.portal_change_fee_now(
  _late_from timestamptz, _kind text, _reschedule_fee integer, _cancel_fee integer)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN _late_from IS NULL OR now() <= _late_from THEN 0
    WHEN _kind = 'reschedule' THEN GREATEST(COALESCE(_reschedule_fee, 0), 0)
    ELSE GREATEST(COALESCE(_cancel_fee, 0), 0)
  END
$function$;

REVOKE ALL ON FUNCTION public.portal_change_fee_now(timestamptz, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_change_fee_now(timestamptz, text, integer, integer) TO service_role;

-- An activity_log line, with the actor's name as their teammates see it.
-- Internal: no client role can call it.
CREATE OR REPLACE FUNCTION public.portal_change_log(
  _org uuid, _client uuid, _kind text, _summary text, _meta jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _actor uuid := auth.uid();
  _label text;
BEGIN
  IF _actor IS NULL THEN
    -- strpos, not LIKE: '_' in a LIKE pattern matches any character.
    _label := CASE WHEN strpos(_kind, 'portal_change.') = 1 THEN 'Customer (portal)' ELSE 'system' END;
  ELSE
    SELECT s.display_name INTO _label
      FROM public.staff s
     WHERE s.user_id = _actor AND s.organization_id = _org
     LIMIT 1;
    _label := COALESCE(_label, 'Someone outside the team');
  END IF;
  INSERT INTO public.activity_log (organization_id, client_id, actor_user_id, actor_label, kind, summary, meta)
  VALUES (_org, _client, _actor, left(_label, 200), _kind, left(_summary, 500), COALESCE(_meta, '{}'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.portal_change_log(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_change_log(uuid, uuid, text, text, jsonb) TO service_role;

-- ── 6. Applying a change: the same writes the two portal RPCs make ────────
-- Re-checks what can have changed since the request (the visit was done,
-- skipped, invoiced, or another visit took the day), but NOT the cutoff: a
-- request made in time is not refused because the owner answered it late.
CREATE OR REPLACE FUNCTION public.portal_change_apply(_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _r public.portal_change_requests%ROWTYPE;
  _sub uuid; _status public.visit_status; _on date;
  _tz text; _today date;
  _price integer; _pct integer; _charge integer;
BEGIN
  SELECT * INTO _r FROM public.portal_change_requests WHERE id = _request_id;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;

  SELECT v.subscription_id, v.status, v.scheduled_on, o.timezone
    INTO _sub, _status, _on, _tz
    FROM public.visits v JOIN public.organizations o ON o.id = v.organization_id
   WHERE v.id = _r.visit_id AND v.client_id = _r.client_id
   FOR UPDATE OF v;
  IF _status IS DISTINCT FROM 'scheduled'::public.visit_status THEN
    RAISE EXCEPTION 'This visit is no longer scheduled, so the change cannot be applied';
  END IF;
  -- The office may have moved the visit since the client asked. The request
  -- is about the day it names, so it is refused rather than applied to a
  -- visit the queue no longer describes.
  IF _on IS DISTINCT FROM _r.original_date THEN
    RAISE EXCEPTION 'STALE_REQUEST: This visit was moved to % after the client asked about %. Deny this request; the client can ask again', _on, _r.original_date;
  END IF;
  _today := (now() AT TIME ZONE COALESCE(NULLIF(_tz, ''), 'UTC'))::date;
  IF _on < _today THEN
    RAISE EXCEPTION 'This visit''s day has passed';
  END IF;

  IF _r.kind = 'reschedule' THEN
    IF _sub IS NULL THEN RAISE EXCEPTION 'Visit not eligible to reschedule'; END IF;
    IF _r.requested_date < (_today + 1) THEN
      RAISE EXCEPTION 'The date asked for has passed. Deny this and ask the customer for another';
    END IF;
    IF EXISTS (SELECT 1 FROM public.visits
                WHERE subscription_id = _sub AND scheduled_on = _r.requested_date AND id <> _r.visit_id) THEN
      RAISE EXCEPTION 'A visit is already scheduled on that date';
    END IF;
    IF EXISTS (SELECT 1 FROM public.invoice_line_items WHERE visit_id = _r.visit_id) THEN
      RAISE EXCEPTION 'Visit is already invoiced';
    END IF;
    UPDATE public.visits
       SET scheduled_on = _r.requested_date,
           sequence = NULL,
           assigned_staff_id = NULL,
           eta_start = NULL,
           eta_end = NULL,
           travel_km = NULL,
           travel_min = NULL,
           window_violated = false,
           updated_at = now()
     WHERE id = _r.visit_id;
  ELSE
    -- portal_request_skip's billing, unchanged: the business's
    -- customer_requested percentage of the plan price.
    SELECT s.price_cents INTO _price FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id WHERE v.id = _r.visit_id;
    SELECT billable_pct INTO _pct FROM public.skip_billing_rules
     WHERE organization_id = _r.organization_id AND reason_code = 'customer_requested';
    IF _pct IS NULL THEN _pct := 0; END IF;
    _charge := ROUND(COALESCE(_price, 0) * _pct / 100.0)::int;
    UPDATE public.visits SET status = 'skipped',
      skip_reason = COALESCE(NULLIF(trim(_r.reason), ''), 'Customer requested via portal'),
      skip_reason_code = 'customer_requested', skip_billable = (_charge > 0),
      skip_charge_cents = _charge, updated_at = now()
     WHERE id = _r.visit_id;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.portal_change_apply(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_change_apply(uuid) TO service_role;

-- ── 7. The customer asks ──────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.portal_request_visit_change(uuid, uuid, text, date, text, integer);
CREATE OR REPLACE FUNCTION public.portal_request_visit_change(
  _token uuid,
  _visit_id uuid,
  _kind text,
  _new_date date,
  _reason text,
  _accepted_fee_cents integer,
  _idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _cid uuid; _org uuid; _allow boolean; _tz text;
  _on date; _sub uuid; _today date;
  _t record; _fee integer; _id uuid; _status text;
  _prev public.portal_change_requests%ROWTYPE;
BEGIN
  IF _kind NOT IN ('reschedule', 'cancel') THEN RAISE EXCEPTION 'Unknown change'; END IF;
  IF _idempotency_key IS NULL OR length(_idempotency_key) NOT BETWEEN 8 AND 100 THEN
    RAISE EXCEPTION 'A request key is required';
  END IF;
  IF _kind = 'cancel' THEN _new_date := NULL; END IF;

  SELECT c.id, c.organization_id, o.portal_allow_self_reschedule, o.timezone
    INTO _cid, _org, _allow, _tz
    FROM public.clients c
    JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;

  IF _kind = 'reschedule' AND NOT COALESCE(_allow, false) THEN
    RAISE EXCEPTION 'Rescheduling from the portal is turned off for this account. Contact the office';
  END IF;

  -- Take the visit's row lock FIRST, whatever its status, so two submissions
  -- for one visit run one after the other. The second then finds the first:
  -- by its key (a retry or a double tap) it gets the same answer back, and
  -- otherwise it meets the visit as the first left it, already moved or
  -- skipped. Either way one press makes one request and at most one fee.
  PERFORM 1 FROM public.visits v
   WHERE v.id = _visit_id AND v.client_id = _cid AND v.organization_id = _org
   FOR UPDATE;

  SELECT * INTO _prev FROM public.portal_change_requests
   WHERE client_id = _cid AND idempotency_key = _idempotency_key;
  IF _prev.id IS NOT NULL THEN
    IF _prev.visit_id <> _visit_id OR _prev.kind <> _kind
       OR _prev.requested_date IS DISTINCT FROM _new_date THEN
      RAISE EXCEPTION 'This request key was already used for a different change';
    END IF;
    RETURN jsonb_build_object('request_id', _prev.id, 'status', _prev.status,
                              'fee_cents', _prev.fee_cents, 'kind', _prev.kind, 'replayed', true);
  END IF;

  -- The visit must be this client's, in this business, and not started.
  SELECT v.scheduled_on, v.subscription_id INTO _on, _sub
    FROM public.visits v
   WHERE v.id = _visit_id AND v.client_id = _cid AND v.organization_id = _org
     AND v.status = 'scheduled'
   FOR UPDATE;
  IF _on IS NULL THEN
    RAISE EXCEPTION '%', CASE WHEN _kind = 'reschedule' THEN 'Visit not eligible to reschedule'
                              ELSE 'Visit not eligible to skip' END;
  END IF;

  SELECT * INTO _t FROM public.portal_change_terms(_visit_id);
  IF now() > _t.cutoff_at THEN
    RAISE EXCEPTION 'This visit is past the change cutoff. Contact the office';
  END IF;

  IF _kind = 'reschedule' THEN
    IF _sub IS NULL THEN RAISE EXCEPTION 'Visit not eligible to reschedule'; END IF;
    IF _new_date IS NULL THEN RAISE EXCEPTION 'Choose a new date'; END IF;
    -- Moving a visit to the day it is already on changes nothing, and must
    -- not cost anything.
    IF _new_date = _on THEN RAISE EXCEPTION 'This visit is already on that date'; END IF;
    _today := (now() AT TIME ZONE COALESCE(NULLIF(_tz, ''), 'UTC'))::date;
    IF _new_date < (_today + 1) THEN RAISE EXCEPTION 'Choose a date at least one day in the future'; END IF;
    IF _new_date > (_today + 60) THEN RAISE EXCEPTION 'Reschedule window is 60 days'; END IF;
    IF EXISTS (SELECT 1 FROM public.visits
                WHERE subscription_id = _sub AND scheduled_on = _new_date AND id <> _visit_id) THEN
      RAISE EXCEPTION 'A visit is already scheduled on that date';
    END IF;
    IF EXISTS (SELECT 1 FROM public.invoice_line_items WHERE visit_id = _visit_id) THEN
      RAISE EXCEPTION 'Visit is already invoiced';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.portal_change_requests
              WHERE visit_id = _visit_id AND status = 'pending') THEN
    RAISE EXCEPTION 'A change to this visit is already waiting for the office';
  END IF;

  -- Never a figure from the browser: the server's, compared with what the
  -- browser says it showed. A mismatch is refused, not charged.
  _fee := public.portal_change_fee_now(_t.late_from, _kind, _t.reschedule_fee_cents, _t.cancel_fee_cents);
  IF _fee > 0 AND _accepted_fee_cents IS DISTINCT FROM _fee THEN
    RAISE EXCEPTION 'FEE_NOT_ACCEPTED: This change now carries a fee of % cents. Review it and try again', _fee;
  END IF;

  INSERT INTO public.portal_change_requests (
    organization_id, client_id, visit_id, kind, original_date, requested_date, reason,
    policy, status, service_line, late, fee_cents, fee_disclosed_cents, idempotency_key)
  VALUES (
    _org, _cid, _visit_id, _kind, _on, _new_date, NULLIF(left(trim(COALESCE(_reason, '')), 500), ''),
    _t.policy, 'pending', _t.service_line,
    (_t.late_from IS NOT NULL AND now() > _t.late_from), _fee,
    CASE WHEN _fee > 0 THEN _accepted_fee_cents END, _idempotency_key)
  RETURNING id INTO _id;

  PERFORM public.portal_change_log(_org, _cid, 'portal_change.requested',
    format('Customer asked to %s the %s visit%s', _kind, _on,
           CASE WHEN _new_date IS NOT NULL THEN format(' to %s', _new_date) ELSE '' END),
    jsonb_build_object('request_id', _id, 'visit_id', _visit_id, 'kind', _kind,
                       'from', _on, 'to', _new_date, 'policy', _t.policy, 'fee_cents', _fee));

  IF _t.policy = 'instant' THEN
    PERFORM public.portal_change_apply(_id);
    UPDATE public.portal_change_requests SET status = 'applied', decided_at = now() WHERE id = _id;
    PERFORM public.portal_change_log(_org, _cid, 'portal_change.applied',
      format('Applied at once (the business applies portal changes instantly): %s of the %s visit', _kind, _on),
      jsonb_build_object('request_id', _id, 'visit_id', _visit_id, 'kind', _kind, 'fee_cents', _fee));
    _status := 'applied';
  ELSE
    _status := 'pending';
  END IF;

  RETURN jsonb_build_object('request_id', _id, 'status', _status, 'fee_cents', _fee, 'kind', _kind);
END;
$function$;

REVOKE ALL ON FUNCTION public.portal_request_visit_change(uuid, uuid, text, date, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_request_visit_change(uuid, uuid, text, date, text, integer, text) TO service_role;

-- The customer takes back a request that is still waiting.
CREATE OR REPLACE FUNCTION public.portal_withdraw_change_request(_token uuid, _request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _cid uuid; _org uuid; _r public.portal_change_requests%ROWTYPE;
BEGIN
  SELECT c.id, c.organization_id INTO _cid, _org
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;

  SELECT * INTO _r FROM public.portal_change_requests
   WHERE id = _request_id AND client_id = _cid AND organization_id = _org
   FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF _r.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been answered'; END IF;

  UPDATE public.portal_change_requests
     SET status = 'withdrawn', decided_at = now()
   WHERE id = _r.id;
  PERFORM public.portal_change_log(_org, _cid, 'portal_change.withdrawn',
    format('Customer withdrew their request to %s the %s visit', _r.kind, _r.original_date),
    jsonb_build_object('request_id', _r.id, 'visit_id', _r.visit_id, 'kind', _r.kind));
END;
$function$;

REVOKE ALL ON FUNCTION public.portal_withdraw_change_request(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_withdraw_change_request(uuid, uuid) TO service_role;

-- What the portal shows next to each upcoming visit: the line's cutoff, when
-- a fee starts and how much, any request still waiting, and the owner's
-- answer when the latest request about this visit was declined.
DROP FUNCTION IF EXISTS public.portal_visit_change_terms(uuid);
CREATE OR REPLACE FUNCTION public.portal_visit_change_terms(_token uuid)
 RETURNS TABLE(
   visit_id uuid,
   policy text,
   cutoff_at timestamptz,
   late_from timestamptz,
   reschedule_fee_cents integer,
   cancel_fee_cents integer,
   pending_request_id uuid,
   pending_kind text,
   pending_requested_date date,
   denied_kind text,
   denied_requested_date date,
   denied_note text,
   denied_at timestamptz
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT v.id, t.policy, t.cutoff_at, t.late_from, t.reschedule_fee_cents, t.cancel_fee_cents,
         pr.id, pr.kind, pr.requested_date,
         CASE WHEN last.status = 'denied' THEN last.kind END,
         CASE WHEN last.status = 'denied' THEN last.requested_date END,
         CASE WHEN last.status = 'denied' THEN last.decision_note END,
         CASE WHEN last.status = 'denied' THEN last.decided_at END
    FROM public.clients c
    JOIN public.organizations o ON o.id = c.organization_id
    JOIN public.visits v ON v.client_id = c.id AND v.organization_id = c.organization_id
    CROSS JOIN LATERAL public.portal_change_terms(v.id) t
    LEFT JOIN public.portal_change_requests pr ON pr.visit_id = v.id AND pr.status = 'pending'
    LEFT JOIN LATERAL (
      SELECT r.status, r.kind, r.requested_date, r.decision_note, r.decided_at
        FROM public.portal_change_requests r
       WHERE r.visit_id = v.id AND r.client_id = c.id
       ORDER BY r.created_at DESC
       LIMIT 1
    ) last ON true
   WHERE c.portal_token = _token AND c.active = true
     AND v.scheduled_on >= (now() AT TIME ZONE COALESCE(NULLIF(o.timezone, ''), 'UTC'))::date
     AND v.status IN ('scheduled', 'in_progress')
$function$;

REVOKE ALL ON FUNCTION public.portal_visit_change_terms(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_visit_change_terms(uuid) TO service_role;

-- Every reschedule and skip this client asked for in the last 120 days, with
-- the owner's answer and note: what the portal's Requests tab shows, so a
-- denial is never just a badge that went away.
CREATE OR REPLACE FUNCTION public.portal_list_change_requests(_token uuid)
 RETURNS TABLE(
   request_id uuid,
   visit_id uuid,
   kind text,
   status text,
   original_date date,
   requested_date date,
   fee_cents integer,
   decision_note text,
   decided_at timestamptz,
   created_at timestamptz
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.id, r.visit_id, r.kind, r.status, r.original_date, r.requested_date, r.fee_cents,
         r.decision_note, r.decided_at, r.created_at
    FROM public.clients c
    JOIN public.portal_change_requests r
      ON r.client_id = c.id AND r.organization_id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true
     AND r.created_at > now() - interval '120 days'
   ORDER BY r.created_at DESC
   LIMIT 50
$function$;

REVOKE ALL ON FUNCTION public.portal_list_change_requests(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_change_requests(uuid) TO service_role;

-- ── 8. The owner answers ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.decide_portal_change_request(
  _request_id uuid, _approve boolean, _note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _r public.portal_change_requests%ROWTYPE; _status text;
BEGIN
  SELECT * INTO _r FROM public.portal_change_requests WHERE id = _request_id FOR UPDATE;
  -- Same answer for "no such request" and "another business's request", so
  -- nothing about another tenant can be learned by asking.
  IF _r.id IS NULL OR auth.uid() IS NULL
     OR NOT public.has_role(auth.uid(), _r.organization_id, 'owner'::public.app_role) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Only an owner of this business can approve or deny a portal change.';
  END IF;
  IF _r.status <> 'pending' THEN
    RAISE EXCEPTION 'This request has already been answered (%)', _r.status;
  END IF;

  IF _approve THEN
    PERFORM public.portal_change_apply(_r.id);
    _status := 'approved';
  ELSE
    _status := 'denied';
  END IF;

  UPDATE public.portal_change_requests
     SET status = _status, decided_by = auth.uid(), decided_at = now(),
         decision_note = NULLIF(left(trim(COALESCE(_note, '')), 500), '')
   WHERE id = _r.id;

  PERFORM public.portal_change_log(_r.organization_id, _r.client_id, 'portal_change.' || _status,
    format('%s the customer''s request to %s the %s visit%s',
           CASE WHEN _approve THEN 'Approved' ELSE 'Denied' END, _r.kind, _r.original_date,
           CASE WHEN _r.requested_date IS NOT NULL THEN format(' to %s', _r.requested_date) ELSE '' END),
    jsonb_build_object('request_id', _r.id, 'visit_id', _r.visit_id, 'kind', _r.kind,
                       'fee_cents', _r.fee_cents, 'note', NULLIF(trim(COALESCE(_note, '')), '')));

  RETURN jsonb_build_object('request_id', _r.id, 'status', _status,
                            'fee_cents', CASE WHEN _approve THEN _r.fee_cents ELSE 0 END);
END;
$function$;

REVOKE ALL ON FUNCTION public.decide_portal_change_request(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_portal_change_request(uuid, boolean, text) TO authenticated, service_role;

-- ── 9. The owner's settings ───────────────────────────────────────────────
-- _rules: [{"service_line": "...", "cutoff_hours": int|null,
--           "late_window_hours": int|null, "late_reschedule_fee_cents": int,
--           "late_cancel_fee_cents": int}, ...]. A line not named is left as
-- it is. NULL policy / autocharge leave those as they are.
CREATE OR REPLACE FUNCTION public.set_portal_change_settings(
  _org uuid, _policy text, _autocharge boolean, _rules jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _el jsonb; _old jsonb; _new jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), _org, 'owner'::public.app_role) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Only an owner can change how portal changes are handled.';
  END IF;
  IF _policy IS NOT NULL AND _policy NOT IN ('instant', 'approval') THEN
    RAISE EXCEPTION 'Unknown policy';
  END IF;

  -- The organization trigger logs the policy and the switch.
  UPDATE public.organizations
     SET portal_change_policy = COALESCE(_policy, portal_change_policy),
         portal_change_fees_autocharge = COALESCE(_autocharge, portal_change_fees_autocharge)
   WHERE id = _org;

  IF _rules IS NOT NULL AND jsonb_typeof(_rules) = 'array' THEN
    FOR _el IN SELECT * FROM jsonb_array_elements(_rules) LOOP
      SELECT to_jsonb(r) - 'updated_at' - 'updated_by' - 'organization_id' INTO _old
        FROM public.portal_change_rules r
       WHERE r.organization_id = _org AND r.service_line = _el->>'service_line';

      INSERT INTO public.portal_change_rules AS r (
        organization_id, service_line, cutoff_hours, late_window_hours,
        late_reschedule_fee_cents, late_cancel_fee_cents, updated_at, updated_by)
      VALUES (
        _org, _el->>'service_line',
        NULLIF(_el->>'cutoff_hours', '')::integer,
        NULLIF(_el->>'late_window_hours', '')::integer,
        COALESCE(NULLIF(_el->>'late_reschedule_fee_cents', '')::integer, 0),
        COALESCE(NULLIF(_el->>'late_cancel_fee_cents', '')::integer, 0),
        now(), auth.uid())
      ON CONFLICT (organization_id, service_line) DO UPDATE
        SET cutoff_hours = EXCLUDED.cutoff_hours,
            late_window_hours = EXCLUDED.late_window_hours,
            late_reschedule_fee_cents = EXCLUDED.late_reschedule_fee_cents,
            late_cancel_fee_cents = EXCLUDED.late_cancel_fee_cents,
            updated_at = now(), updated_by = auth.uid();

      SELECT to_jsonb(r) - 'updated_at' - 'updated_by' - 'organization_id' INTO _new
        FROM public.portal_change_rules r
       WHERE r.organization_id = _org AND r.service_line = _el->>'service_line';

      IF _old IS DISTINCT FROM _new THEN
        PERFORM public.portal_change_log(_org, NULL, 'org.portal_change_rules_changed',
          format('Changed the portal change rules for %s', _el->>'service_line'),
          jsonb_build_object('service_line', _el->>'service_line', 'from', _old, 'to', _new));
      END IF;
    END LOOP;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_portal_change_settings(uuid, text, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_portal_change_settings(uuid, text, boolean, jsonb) TO authenticated, service_role;

-- Only an owner writes the two organization columns, by any path. The
-- service role (the app's server, migrations, the seeder) has no auth.uid()
-- and is let through: the server function asks for an owner before it writes.
CREATE OR REPLACE FUNCTION public.tg_orgs_portal_change_owner_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.portal_change_policy IS NOT DISTINCT FROM OLD.portal_change_policy
     AND NEW.portal_change_fees_autocharge IS NOT DISTINCT FROM OLD.portal_change_fees_autocharge THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT public.has_role(auth.uid(), NEW.id, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only an owner can change how portal changes are handled.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_orgs_portal_change_owner_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orgs_portal_change_owner_only ON public.organizations;
CREATE TRIGGER orgs_portal_change_owner_only
  BEFORE UPDATE OF portal_change_policy, portal_change_fees_autocharge ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_orgs_portal_change_owner_only();

-- Who changed it. AFTER, so a refused write logs nothing.
CREATE OR REPLACE FUNCTION public.tg_orgs_log_portal_change_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.portal_change_policy IS DISTINCT FROM NEW.portal_change_policy THEN
    PERFORM public.portal_change_log(NEW.id, NULL, 'org.portal_change_policy_changed',
      format('Portal reschedules and cancels: %s → %s',
             CASE OLD.portal_change_policy WHEN 'approval' THEN 'wait for approval' ELSE 'apply instantly' END,
             CASE NEW.portal_change_policy WHEN 'approval' THEN 'wait for approval' ELSE 'apply instantly' END),
      jsonb_build_object('from', OLD.portal_change_policy, 'to', NEW.portal_change_policy));
  END IF;
  IF OLD.portal_change_fees_autocharge IS DISTINCT FROM NEW.portal_change_fees_autocharge THEN
    PERFORM public.portal_change_log(NEW.id, NULL, 'org.portal_change_autocharge_changed',
      format('Automatic late-change fee charging turned %s',
             CASE WHEN NEW.portal_change_fees_autocharge THEN 'on' ELSE 'off' END),
      jsonb_build_object('from', OLD.portal_change_fees_autocharge, 'to', NEW.portal_change_fees_autocharge));
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_orgs_log_portal_change_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orgs_log_portal_change_settings ON public.organizations;
CREATE TRIGGER orgs_log_portal_change_settings
  AFTER UPDATE OF portal_change_policy, portal_change_fees_autocharge ON public.organizations
  FOR EACH ROW
  WHEN (OLD.portal_change_policy IS DISTINCT FROM NEW.portal_change_policy
        OR OLD.portal_change_fees_autocharge IS DISTINCT FROM NEW.portal_change_fees_autocharge)
  EXECUTE FUNCTION public.tg_orgs_log_portal_change_settings();

-- ── 10. Fees: begun by the server, settled by the webhook ─────────────────

-- The charge row for an applied or approved request with a fee, created once.
-- The amount is the request's, which the server computed. Returns the row as
-- jsonb, and whether it was created by this call.
CREATE OR REPLACE FUNCTION public.begin_portal_change_fee(_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _r public.portal_change_requests%ROWTYPE; _c public.portal_change_fee_charges%ROWTYPE; _new boolean := false;
BEGIN
  SELECT * INTO _r FROM public.portal_change_requests WHERE id = _request_id;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF _r.status NOT IN ('applied', 'approved') THEN
    RAISE EXCEPTION 'Only an applied or approved change carries a fee';
  END IF;
  IF _r.fee_cents <= 0 THEN
    RETURN jsonb_build_object('charge', NULL, 'created', false);
  END IF;

  INSERT INTO public.portal_change_fee_charges (organization_id, client_id, request_id, amount_cents, idempotency_key)
  VALUES (_r.organization_id, _r.client_id, _r.id, _r.fee_cents, 'portal-change-fee:' || _r.id::text)
  ON CONFLICT (request_id) DO NOTHING
  RETURNING * INTO _c;
  IF _c.id IS NOT NULL THEN
    _new := true;
  ELSE
    SELECT * INTO _c FROM public.portal_change_fee_charges WHERE request_id = _r.id;
  END IF;
  RETURN jsonb_build_object('charge', to_jsonb(_c), 'created', _new);
END;
$function$;

REVOKE ALL ON FUNCTION public.begin_portal_change_fee(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_portal_change_fee(uuid) TO service_role;

-- Before the server calls Stripe, the fee row records the connected account
-- it is about to charge on. With that stored, a webhook that beats the
-- server's own response can still be matched: by the fee id the PaymentIntent
-- carries AND that account (record_portal_change_fee_event). Only a fee still
-- waiting to be charged can be prepared, and never for a second account.
CREATE OR REPLACE FUNCTION public.prepare_portal_change_fee(_charge_id uuid, _account text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF _account IS NULL OR _account = '' THEN RAISE EXCEPTION 'An account is required'; END IF;
  UPDATE public.portal_change_fee_charges
     SET stripe_account_id = _account, updated_at = now()
   WHERE id = _charge_id AND status = 'pending'
     AND (stripe_account_id IS NULL OR stripe_account_id = _account);
  IF NOT FOUND THEN RAISE EXCEPTION 'This fee is not waiting to be charged on that account'; END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.prepare_portal_change_fee(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_portal_change_fee(uuid, text) TO service_role;

-- What the server learned from its own call to Stripe (or why it made none).
-- Never 'succeeded': only a verified webhook says money moved.
CREATE OR REPLACE FUNCTION public.note_portal_change_fee_attempt(
  _charge_id uuid, _status text, _payment_intent_id text, _account text, _reason text, _livemode boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _c public.portal_change_fee_charges%ROWTYPE;
BEGIN
  IF _status NOT IN ('not_charged', 'processing', 'requires_action', 'failed') THEN
    RAISE EXCEPTION 'A fee attempt cannot be recorded as %', _status;
  END IF;
  SELECT * INTO _c FROM public.portal_change_fee_charges WHERE id = _charge_id FOR UPDATE;
  IF _c.id IS NULL THEN RAISE EXCEPTION 'Fee not found'; END IF;
  -- A webhook that arrived first wins.
  IF _c.status IN ('succeeded', 'failed') AND _c.last_event_id IS NOT NULL THEN RETURN; END IF;

  UPDATE public.portal_change_fee_charges
     SET status = _status,
         stripe_payment_intent_id = COALESCE(_payment_intent_id, stripe_payment_intent_id),
         stripe_account_id = COALESCE(_account, stripe_account_id),
         not_charged_reason = CASE WHEN _status = 'not_charged' THEN left(_reason, 300) END,
         failure_message = CASE WHEN _status = 'failed' THEN left(_reason, 300) END,
         livemode = COALESCE(_livemode, livemode),
         updated_at = now()
   WHERE id = _c.id;

  IF _status IN ('not_charged', 'failed') AND _c.status IS DISTINCT FROM _status THEN
    PERFORM public.portal_change_log(_c.organization_id, _c.client_id,
      'portal_change_fee.' || _status,
      format('Late-change fee of %s cents %s: %s', _c.amount_cents,
             CASE WHEN _status = 'failed' THEN 'failed' ELSE 'not charged' END, COALESCE(_reason, '')),
      jsonb_build_object('charge_id', _c.id, 'request_id', _c.request_id, 'amount_cents', _c.amount_cents,
                         'reason', _reason));
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.note_portal_change_fee_attempt(uuid, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_portal_change_fee_attempt(uuid, text, text, text, text, boolean) TO service_role;

-- A verified Stripe event. Recorded once per event id; a duplicate returns
-- 'duplicate' and changes nothing. The charge is found by its PaymentIntent
-- AND the connected account the event came from, so one tenant's event can
-- never settle another tenant's fee. A failure after a success does not undo
-- the success (Stripe does not promise order).
DROP FUNCTION IF EXISTS public.record_portal_change_fee_event(text, text, text, text, boolean, text, boolean);
CREATE OR REPLACE FUNCTION public.record_portal_change_fee_event(
  _event_id text, _event_type text, _payment_intent_id text, _account text,
  _succeeded boolean, _message text, _livemode boolean, _charge_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _c public.portal_change_fee_charges%ROWTYPE; _n integer; _to text;
BEGIN
  IF _event_id IS NULL OR _payment_intent_id IS NULL OR _account IS NULL THEN
    RETURN 'ignored';
  END IF;

  SELECT * INTO _c FROM public.portal_change_fee_charges
   WHERE stripe_payment_intent_id = _payment_intent_id
     AND stripe_account_id = _account
   FOR UPDATE;
  -- The webhook can arrive before the server has stored the intent's id.
  -- The fee id in the intent's metadata finds the row, but only when that
  -- row was prepared for THIS account (prepare_portal_change_fee), so a
  -- connected account can never name another tenant's fee. The intent's id
  -- is stored here and the server's later note agrees with it.
  IF _c.id IS NULL AND _charge_id IS NOT NULL THEN
    SELECT * INTO _c FROM public.portal_change_fee_charges
     WHERE id = _charge_id
       AND stripe_account_id = _account
       AND (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id = _payment_intent_id)
     FOR UPDATE;
    IF _c.id IS NOT NULL THEN
      UPDATE public.portal_change_fee_charges
         SET stripe_payment_intent_id = _payment_intent_id, updated_at = now()
       WHERE id = _c.id;
    END IF;
  END IF;
  -- Still nothing: the caller answers non-2xx so Stripe delivers it again.
  IF _c.id IS NULL THEN RETURN 'unknown'; END IF;

  INSERT INTO public.portal_change_fee_events (event_id, charge_id, organization_id, event_type)
  VALUES (_event_id, _c.id, _c.organization_id, _event_type)
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n = 0 THEN RETURN 'duplicate'; END IF;

  _to := CASE WHEN _succeeded THEN 'succeeded' ELSE 'failed' END;
  IF _c.status = 'succeeded' OR _c.status = _to THEN RETURN 'unchanged'; END IF;

  UPDATE public.portal_change_fee_charges
     SET status = _to,
         failure_message = CASE WHEN _to = 'failed' THEN left(_message, 300) END,
         livemode = COALESCE(_livemode, livemode),
         last_event_id = _event_id,
         updated_at = now()
   WHERE id = _c.id;

  PERFORM public.portal_change_log(_c.organization_id, _c.client_id,
    'portal_change_fee.' || CASE WHEN _succeeded THEN 'charged' ELSE 'failed' END,
    format('Late-change fee of %s cents %s', _c.amount_cents,
           CASE WHEN _succeeded THEN 'charged' ELSE 'failed: ' || COALESCE(_message, 'declined') END),
    jsonb_build_object('charge_id', _c.id, 'request_id', _c.request_id, 'amount_cents', _c.amount_cents,
                       'payment_intent_id', _payment_intent_id, 'event_id', _event_id));
  RETURN _to;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_portal_change_fee_event(text, text, text, text, boolean, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_portal_change_fee_event(text, text, text, text, boolean, text, boolean, uuid) TO service_role;

-- ── 11. What this file establishes ────────────────────────────────────────
DO $check$
DECLARE _fn text;
BEGIN
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organizations'
         AND column_name = 'portal_change_policy') NOT LIKE '''approval''%' THEN
    RAISE EXCEPTION 'a new business does not start on approval';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organizations'
         AND column_name = 'portal_change_fees_autocharge') <> 'false' THEN
    RAISE EXCEPTION 'automatic fee charging is not off by default';
  END IF;

  -- Each new RLS table carries the two-step sign-in policy, and no client
  -- role can write any of them directly. Permissive policies only are counted
  -- (#302): the MFA policy is restrictive.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('portal_change_rules', 'portal_change_requests',
                         'portal_change_fee_charges', 'portal_change_fee_events')
       AND permissive = 'PERMISSIVE' AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'a portal change table has a permissive write policy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'portal_change_fee_events'
       AND permissive = 'PERMISSIVE'
  ) THEN
    RAISE EXCEPTION 'portal_change_fee_events is readable by a client role';
  END IF;
  IF has_table_privilege('authenticated', 'public.portal_change_requests', 'INSERT')
     OR has_table_privilege('authenticated', 'public.portal_change_fee_charges', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.portal_change_rules', 'INSERT') THEN
    RAISE EXCEPTION 'a client role holds a write grant on a portal change table';
  END IF;

  -- Nothing a customer calls is callable by a client role.
  FOREACH _fn IN ARRAY ARRAY[
    'public.portal_request_visit_change(uuid, uuid, text, date, text, integer, text)',
    'public.portal_list_change_requests(uuid)',
    'public.prepare_portal_change_fee(uuid, text)',
    'public.portal_withdraw_change_request(uuid, uuid)',
    'public.portal_visit_change_terms(uuid)',
    'public.portal_change_apply(uuid)',
    'public.begin_portal_change_fee(uuid)',
    'public.note_portal_change_fee_attempt(uuid, text, text, text, text, boolean)',
    'public.record_portal_change_fee_event(text, text, text, text, boolean, text, boolean, uuid)',
    'public.portal_change_log(uuid, uuid, text, text, jsonb)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable by a client role', _fn;
    END IF;
    IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute %', _fn;
    END IF;
  END LOOP;

  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.decide_portal_change_request(uuid, boolean, text)'::regprocedure),
            'public.has_role(auth.uid(), _r.organization_id, ''owner''::public.app_role)') = 0 THEN
    RAISE EXCEPTION 'decide_portal_change_request does not ask for an owner of the request''s business';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.set_portal_change_settings(uuid, text, boolean, jsonb)'::regprocedure),
            'public.has_role(auth.uid(), _org, ''owner''::public.app_role)') = 0 THEN
    RAISE EXCEPTION 'set_portal_change_settings does not ask for an owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organizations'::regclass
                  AND tgname = 'orgs_portal_change_owner_only' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organizations'::regclass
                  AND tgname = 'orgs_log_portal_change_settings' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'the portal change settings are not guarded and logged';
  END IF;

  -- The fee arithmetic, data-free.
  IF public.portal_change_fee_now(NULL, 'cancel', 500, 700) <> 0
     OR public.portal_change_fee_now(now() + interval '1 hour', 'cancel', 500, 700) <> 0
     OR public.portal_change_fee_now(now() - interval '1 hour', 'cancel', 500, 700) <> 700
     OR public.portal_change_fee_now(now() - interval '1 hour', 'reschedule', 500, 700) <> 500
     OR public.portal_change_fee_now(now() - interval '1 hour', 'reschedule', -5, 700) <> 0 THEN
    RAISE EXCEPTION 'portal_change_fee_now does not compute the late fee as specified';
  END IF;
END
$check$;
