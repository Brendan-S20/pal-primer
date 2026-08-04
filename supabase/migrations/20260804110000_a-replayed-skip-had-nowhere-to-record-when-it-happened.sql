-- Skip was the one lifecycle action the offline replay passed no timestamp for
-- — and it had nowhere to put one.
--
-- `sync.ts` carries `action.ts` (when the tech DID the thing) for `start` and
-- `complete`, directly under a comment block asserting exactly that. `skip` sat
-- in the same switch passing nothing, so a skip queued at 9:15am in a dead zone
-- and replayed at 4pm left no record of 9:15 anywhere: `updated_at` is when the
-- ROW changed, which for a replay is hours after the fact, and there was no
-- other column.
--
-- So `skipped_at`, and the same bounds `complete_visit` uses — a device clock
-- is a hint, never the safeguard, and every rejection falls back to now()
-- rather than failing, because the skip itself is real either way.
--
-- The old 3-argument signature is dropped for the reason the last two
-- re-signings were: Postgres overloads on the argument list, so leaving it
-- would make `skip_visit(id, reason, code)` ambiguous once the fourth parameter
-- has a default, and every ONLINE skip makes exactly that call.

ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS skipped_at timestamptz;

COMMENT ON COLUMN public.visits.skipped_at IS
  'When the tech actually skipped the visit. Distinct from updated_at, which is when the ROW last changed — a replayed skip updates the row hours after the fact. Null on every skip recorded before this column existed.';

CREATE OR REPLACE FUNCTION public.skip_visit(
  _visit_id uuid,
  _reason text,
  _code skip_reason_code DEFAULT 'other'::skip_reason_code,
  _skipped_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _price integer; _pct integer; _charge integer;
  _when timestamptz := now();
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to skip a visit';
  END IF;

  IF _skipped_at IS NOT NULL
     AND _skipped_at <= now()
     AND _skipped_at >= now() - interval '7 days'
  THEN
    _when := _skipped_at;
  END IF;

  SELECT v.organization_id, s.price_cents
    INTO _org, _price
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  SELECT billable_pct INTO _pct
    FROM public.skip_billing_rules
   WHERE organization_id = _org AND reason_code = _code;
  IF _pct IS NULL THEN
    _pct := public.default_skip_billable_pct(_code);
  END IF;

  _charge := ROUND(COALESCE(_price, 0) * _pct / 100.0)::int;

  UPDATE public.visits
     SET status = 'skipped',
         skip_reason = _reason,
         skip_reason_code = _code,
         skip_billable = (_charge > 0),
         skip_charge_cents = _charge,
         skipped_at = _when,
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
END;
$function$;

COMMENT ON FUNCTION public.skip_visit(uuid, text, skip_reason_code, timestamptz) IS
  'Skips a visit. _skipped_at carries the time a QUEUED action was actually performed, bounded exactly as complete_visit bounds its own.';

DROP FUNCTION IF EXISTS public.skip_visit(uuid, text, skip_reason_code);
