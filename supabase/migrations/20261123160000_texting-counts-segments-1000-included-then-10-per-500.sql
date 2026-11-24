-- #988 — Managed texting counts segments: 1,000 a month are included in the
-- $29 add-on, then $10 per extra block of 500, rounded up.
--
-- Today the add-on reads as unlimited and nothing counts a text. This mirrors
-- BUILD-2's AI metering (20260801140000): configuration on the catalog row,
-- an event ledger, a per-month rollup that is RECOUNTED rather than
-- incremented, and a billing claim taken in the database before Stripe is
-- called. Additive only: no existing column or row is changed or dropped,
-- and no billing row is touched.

-- ── the allowance, on the catalog row ──────────────────────────────────────
ALTER TABLE public.platform_addons
  ADD COLUMN IF NOT EXISTS texting_segments_included integer,
  ADD COLUMN IF NOT EXISTS texting_block_size integer,
  ADD COLUMN IF NOT EXISTS texting_block_cents integer,
  ADD COLUMN IF NOT EXISTS texting_ceiling_blocks integer;

COMMENT ON COLUMN public.platform_addons.texting_segments_included IS
  '#988: segments (sent + received) included per org-local month. NULL = not metered.';
COMMENT ON COLUMN public.platform_addons.texting_block_size IS
  '#988: overage is sold in blocks of this many segments, rounded up.';
COMMENT ON COLUMN public.platform_addons.texting_block_cents IS
  '#988: price of one overage block, in cents.';
COMMENT ON COLUMN public.platform_addons.texting_ceiling_blocks IS
  '#988: default hard ceiling, in overage blocks per month. Automatic texts stop at included + ceiling * block size.';

UPDATE public.platform_addons
   SET texting_segments_included = 1000,
       texting_block_size = 500,
       texting_block_cents = 1000,
       texting_ceiling_blocks = 5
 WHERE slug = 'managed-sms';

-- ── the event ledger: one row per segment-bearing text ─────────────────────
CREATE TABLE IF NOT EXISTS public.sms_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- The org-local month, stamped by the writer so the rollup cannot disagree
  -- with the event about which month it was.
  period_month date NOT NULL,
  direction text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  -- What sent it: client_message, on_my_way, reminder, review_request,
  -- portal_code, consent, inbound, ...
  kind text NOT NULL,
  twilio_sid text,
  -- Twilio's own count when it reports one, else our local count.
  num_segments integer NOT NULL CHECK (num_segments >= 0),
  encoding text NOT NULL CHECK (encoding IN ('GSM-7', 'UCS-2')),
  -- Twilio's price for the message in USD, when known. Informational.
  price numeric(10,5),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per Twilio message: a retried webhook or a second write for the
-- same send cannot double count. NOT a partial index: recordSmsSegments writes
-- with ON CONFLICT (twilio_sid), and Postgres only infers that target from a
-- unique index with no WHERE clause (a partial one fails with 42P10 and every
-- text with a SID went uncounted). NULLs never conflict in a unique index, so
-- the texts that have no SID still each get a row. Dropped first so a database
-- that already ran the earlier partial version ends up with the right one.
DROP INDEX IF EXISTS public.sms_usage_events_sid_uniq;
CREATE UNIQUE INDEX sms_usage_events_sid_uniq
  ON public.sms_usage_events (twilio_sid);
CREATE INDEX IF NOT EXISTS sms_usage_events_org_month_idx
  ON public.sms_usage_events (organization_id, period_month);

-- ── the rollup, recounted from the ledger ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sms_usage_periods (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_month date NOT NULL,
  segments integer NOT NULL DEFAULT 0,
  billed_at timestamptz,
  billed_blocks integer,
  billed_cents integer,
  stripe_invoice_item_id text,
  warned_80_at timestamptz,
  warned_100_at timestamptz,
  warned_ceiling_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, period_month)
);

CREATE INDEX IF NOT EXISTS sms_usage_periods_unbilled_idx
  ON public.sms_usage_periods (period_month) WHERE billed_at IS NULL;

CREATE OR REPLACE FUNCTION public.tg_sms_usage_rollup()
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
    INSERT INTO public.sms_usage_periods AS p (organization_id, period_month, segments, updated_at)
    SELECT _org, _month, COALESCE(sum(e.num_segments), 0), now()
      FROM public.sms_usage_events e
     WHERE e.organization_id = _org AND e.period_month = _month
    ON CONFLICT (organization_id, period_month) DO UPDATE
      SET segments = EXCLUDED.segments, updated_at = now();
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sms_usage_rollup ON public.sms_usage_events;
CREATE TRIGGER sms_usage_rollup
  AFTER INSERT OR UPDATE OR DELETE ON public.sms_usage_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_sms_usage_rollup();
REVOKE EXECUTE ON FUNCTION public.tg_sms_usage_rollup() FROM PUBLIC, anon, authenticated;

-- ── RLS: read-only to people who can see the bill; the service role writes ──
ALTER TABLE public.sms_usage_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_usage_periods ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.sms_usage_events');
SELECT public.require_mfa_policy('public.sms_usage_periods');

DROP POLICY IF EXISTS sms_usage_events_read ON public.sms_usage_events;
CREATE POLICY sms_usage_events_read ON public.sms_usage_events
  FOR SELECT TO authenticated
  USING (public.has_permission((select auth.uid()), organization_id, 'manage_org_billing'));

DROP POLICY IF EXISTS sms_usage_periods_read ON public.sms_usage_periods;
CREATE POLICY sms_usage_periods_read ON public.sms_usage_periods
  FOR SELECT TO authenticated
  USING (public.has_permission((select auth.uid()), organization_id, 'manage_org_billing'));

REVOKE ALL ON public.sms_usage_events  FROM anon, authenticated;
REVOKE ALL ON public.sms_usage_periods FROM anon, authenticated;
GRANT SELECT ON public.sms_usage_events  TO authenticated;
GRANT SELECT ON public.sms_usage_periods TO authenticated;

COMMENT ON TABLE public.sms_usage_events IS
  '#988: one row per text sent or received, with Twilio''s segment count. Read-only to tenants; written by the service role.';
COMMENT ON TABLE public.sms_usage_periods IS
  '#988: per-org, per-month segment totals RECOUNTED from sms_usage_events, plus the month''s overage billing claim and warning stamps.';

-- ── where an org stands, one definition ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sms_usage_state(_org_id uuid)
RETURNS TABLE (
  period_month date,
  segments_used integer,
  segments_included integer,
  block_size integer,
  block_cents integer,
  blocks_owed integer,
  overage_cents integer,
  ceiling_segments integer
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
  _inc integer;
  _size integer;
  _cents integer;
  _ceil integer;
  _blocks integer;
BEGIN
  SELECT COALESCE(o.timezone, 'America/Chicago') INTO _tz
    FROM public.organizations o WHERE o.id = _org_id;
  IF _tz IS NULL THEN RETURN; END IF;
  _month := date_trunc('month', (now() AT TIME ZONE _tz))::date;

  SELECT COALESCE(p.segments, 0) INTO _used
    FROM public.sms_usage_periods p
   WHERE p.organization_id = _org_id AND p.period_month = _month;
  _used := COALESCE(_used, 0);

  SELECT a.texting_segments_included, a.texting_block_size, a.texting_block_cents, a.texting_ceiling_blocks
    INTO _inc, _size, _cents, _ceil
    FROM public.platform_addons a WHERE a.slug = 'managed-sms';

  _blocks := CASE WHEN _inc IS NULL OR _size IS NULL OR _size <= 0 OR _used <= _inc THEN 0
                  ELSE ceil((_used - _inc)::numeric / _size)::integer END;

  RETURN QUERY SELECT
    _month, _used, _inc, _size, _cents, _blocks,
    COALESCE(_blocks * _cents, 0),
    CASE WHEN _inc IS NULL OR _size IS NULL OR _ceil IS NULL THEN NULL
         ELSE _inc + _ceil * _size END;
END;
$$;

REVOKE ALL ON FUNCTION public.sms_usage_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sms_usage_state(uuid) TO service_role;

-- ── prove it (rolled back) ─────────────────────────────────────────────────
DO $check$
DECLARE
  _inc integer; _size integer; _cents integer;
BEGIN
  SELECT texting_segments_included, texting_block_size, texting_block_cents
    INTO _inc, _size, _cents FROM public.platform_addons WHERE slug = 'managed-sms';
  IF NOT FOUND THEN
    RAISE WARNING 'no managed-sms add-on on this database; allowance not seeded';
    RETURN;
  END IF;
  IF _inc IS DISTINCT FROM 1000 OR _size IS DISTINCT FROM 500 OR _cents IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION 'managed-sms allowance not 1000 / 500 / 1000 (got %, %, %)', _inc, _size, _cents;
  END IF;
END
$check$;
