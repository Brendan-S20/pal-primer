-- A check for less than the bill.
--
-- QA batch 6, row 12 (A-02). An owner who was handed a $60 check against $80
-- owed had nowhere to put it. "Record payment" had no amount: it wrote the
-- whole open balance and marked the invoice paid. "Collected in the field"
-- could only apply cash to invoices it covered in full, so $60 against $40 +
-- $40 settled one and left $20 floating, and its default choice could skip the
-- older invoice for two newer ones that happened to fit.
--
-- `payments` was already the ledger: one row per payment, `amount_cents` the
-- money applied to the invoice (tip and surcharge are their own columns), and
-- nothing stopped two rows on one invoice. What was missing was any reader
-- that summed them. Every balance in the product was `total_cents -
-- credit_applied_cents`, so a second payment had nowhere to show up.
--
-- This file:
--
--   1. invoices.amount_paid_cents: the sum of the invoice's succeeded
--      payments. Kept by a trigger on payments, so every writer (the office,
--      the Stripe webhook, reconcile, a refund that flips a row) moves it the
--      same way, and nobody else can write it. Backfilled from the ledger.
--      An invoice's balance is now total - credit applied - amount paid.
--
--   2. record_invoice_payment: an amount against one invoice. It locks the
--      invoice, refuses more than the balance ("That is more than the $20.00
--      still owed"), writes the payment, and marks the invoice paid only when
--      the balance reaches zero. Below that it stays open, partially paid.
--      There is no new status: "partially paid" is open with money on it.
--
--   3. confirm_field_collection: applies the cash oldest invoice first, the
--      last one partly if that is where the money runs out, and records the
--      payments itself, so a confirmation and its payments are one
--      transaction. It returns what went where.
--
--   4. The four functions that computed a balance the old way, re-issued with
--      the payment subtracted and nothing else changed: record_field_collection
--      (a tech cannot collect more than is owed), my_day_stop_facts (the
--      balance on a stop card), franchise_rollup (each location's open AR) and
--      apply_credit_to_invoice (credit covers what is left, not the whole
--      bill; its ledger note also names INV-1042 rather than an id fragment).
--
-- Replays into an empty database: nothing here needs a tenant, a row or a cron
-- job. The backfill updates whatever payments exist, which on a fresh build is
-- none.

-- ── 1. amount_paid_cents ────────────────────────────────────────────────────

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS amount_paid_cents integer NOT NULL DEFAULT 0;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_amount_paid_cents_nonnegative;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_amount_paid_cents_nonnegative CHECK (amount_paid_cents >= 0);

COMMENT ON COLUMN public.invoices.amount_paid_cents IS
  'Sum of this invoice''s succeeded payments.amount_cents (tips and surcharges excluded). '
  'Written only by tg_payments_sync_invoice_paid. Balance = total_cents - credit_applied_cents - amount_paid_cents.';

-- What the ledger says, read fresh. SECURITY DEFINER because the trigger and
-- the RPCs below need the true sum whoever is calling, and RLS on payments is
-- scoped to billing roles.
CREATE OR REPLACE FUNCTION public.invoice_paid_cents(_invoice_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT GREATEST(COALESCE(sum(p.amount_cents), 0), 0)::integer
    FROM public.payments p
   WHERE p.invoice_id = _invoice_id
     AND p.status = 'succeeded';
$function$;

REVOKE ALL ON FUNCTION public.invoice_paid_cents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_paid_cents(uuid) TO service_role;

-- Only the sync writes the column. A billing role can UPDATE invoices (that
-- is how status flips), and without this it could also set what was paid.
-- The sync announces itself with a transaction-local setting; anything else
-- that tries to move the number is put back, and a new invoice starts at 0.
CREATE OR REPLACE FUNCTION public.tg_invoices_guard_amount_paid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_setting('houndstack.paid_sync', true) IS DISTINCT FROM 'on' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.amount_paid_cents := 0;
    ELSIF NEW.amount_paid_cents IS DISTINCT FROM OLD.amount_paid_cents THEN
      NEW.amount_paid_cents := OLD.amount_paid_cents;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_invoices_guard_amount_paid() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoices_guard_amount_paid ON public.invoices;
CREATE TRIGGER invoices_guard_amount_paid
  BEFORE INSERT OR UPDATE OF amount_paid_cents ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoices_guard_amount_paid();

CREATE OR REPLACE FUNCTION public.sync_invoice_amount_paid(_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _paid integer := public.invoice_paid_cents(_invoice_id);
BEGIN
  PERFORM set_config('houndstack.paid_sync', 'on', true);
  UPDATE public.invoices
     SET amount_paid_cents = _paid
   WHERE id = _invoice_id
     AND amount_paid_cents IS DISTINCT FROM _paid;
  PERFORM set_config('houndstack.paid_sync', 'off', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_invoice_amount_paid(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_invoice_amount_paid(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_payments_sync_invoice_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.invoice_id IS NOT NULL THEN
    PERFORM public.sync_invoice_amount_paid(OLD.invoice_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.invoice_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents) THEN
    PERFORM public.sync_invoice_amount_paid(NEW.invoice_id);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_payments_sync_invoice_paid() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payments_sync_invoice_paid ON public.payments;
CREATE TRIGGER payments_sync_invoice_paid
  AFTER INSERT OR DELETE OR UPDATE OF status, amount_cents, invoice_id ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_payments_sync_invoice_paid();

-- Backfill from the ledger. touch_invoices is held off so updated_at keeps
-- meaning "a person or a process changed this invoice": outstandingAsOf reads
-- it as the write-off day of an uncollectible invoice.
ALTER TABLE public.invoices DISABLE TRIGGER touch_invoices;
SELECT set_config('houndstack.paid_sync', 'on', true);
UPDATE public.invoices i
   SET amount_paid_cents = s.paid
  FROM (
    SELECT p.invoice_id, GREATEST(sum(p.amount_cents), 0)::integer AS paid
      FROM public.payments p
     WHERE p.status = 'succeeded'
     GROUP BY p.invoice_id
  ) s
 WHERE s.invoice_id = i.id
   AND i.amount_paid_cents IS DISTINCT FROM s.paid;
SELECT set_config('houndstack.paid_sync', 'off', true);
ALTER TABLE public.invoices ENABLE TRIGGER touch_invoices;

-- ── 2. record_invoice_payment ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  _invoice_id uuid,
  _amount_cents integer DEFAULT NULL,
  _method text DEFAULT NULL,
  _reference text DEFAULT NULL,
  _paid_at timestamptz DEFAULT now(),
  _note text DEFAULT NULL,
  _field_collection_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _inv public.invoices%ROWTYPE;
  _paid bigint;
  _balance bigint;
  _amount bigint;
  _payment_id uuid;
  _settled boolean;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to record a payment' USING ERRCODE = '42501';
  END IF;

  -- Locked first, so the balance read below is the balance: a second payment
  -- on the same invoice waits here and then sees this one.
  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF _inv.id IS NULL
     OR NOT public.has_permission(_uid, _inv.organization_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Only someone who manages billing can record a payment' USING ERRCODE = '42501';
  END IF;
  -- Paid and void are closed. A draft or a written-off invoice can still be
  -- paid by hand, as it always could from Record payment.
  IF _inv.status IN ('paid', 'void') THEN
    RAISE EXCEPTION 'This invoice is already %, so there is nothing left to pay on it',
      CASE WHEN _inv.status = 'paid' THEN 'paid' ELSE 'void' END
      USING ERRCODE = '22023';
  END IF;

  _paid := public.invoice_paid_cents(_inv.id);
  _balance := GREATEST(COALESCE(_inv.total_cents, 0) - COALESCE(_inv.credit_applied_cents, 0) - _paid, 0);
  -- No amount means the whole balance, which is what every caller before
  -- this file sent.
  _amount := COALESCE(_amount_cents, _balance);

  IF _amount < 0 OR (_amount = 0 AND _balance > 0) THEN
    RAISE EXCEPTION 'Enter an amount greater than zero' USING ERRCODE = '22023';
  END IF;
  IF _amount > _balance THEN
    RAISE EXCEPTION 'That is more than the % still owed on this invoice',
      '$' || to_char(_balance / 100.0, 'FM999,999,990.00')
      USING ERRCODE = '22023';
  END IF;

  IF _amount > 0 THEN
    INSERT INTO public.payments (
      invoice_id, organization_id, collected_by_organization_id, amount_cents, currency,
      status, paid_at, method, reference, raw_event
    ) VALUES (
      _inv.id, _inv.organization_id,
      -- Cash or a check handed to this location: it never passed through
      -- anyone's Stripe account (BUILD-6).
      _inv.organization_id,
      _amount, COALESCE(_inv.currency, 'usd'), 'succeeded', _paid_at, _method,
      NULLIF(btrim(COALESCE(_reference, '')), ''),
      jsonb_build_object(
        'source', 'manual_mark_paid',
        'note', _note,
        'field_collection_id', _field_collection_id,
        'partial', _amount < _balance
      )
    )
    RETURNING id INTO _payment_id;
  END IF;

  _settled := (_amount = _balance);
  IF _settled THEN
    UPDATE public.invoices SET status = 'paid', paid_at = _paid_at WHERE id = _inv.id;
  END IF;

  RETURN jsonb_build_object(
    'payment_id', _payment_id,
    'invoice_id', _inv.id,
    'organization_id', _inv.organization_id,
    'client_id', _inv.client_id,
    'amount_cents', _amount,
    'amount_paid_cents', _paid + _amount,
    'balance_cents', _balance - _amount,
    'paid', _settled
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid, integer, text, text, timestamptz, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, integer, text, text, timestamptz, text, uuid)
  TO authenticated, service_role;

-- ── 3. confirm_field_collection: oldest first, the last one partly ──────────

CREATE OR REPLACE FUNCTION public.confirm_field_collection(
  _collection_id uuid,
  _invoice_ids uuid[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _fc public.field_collections%ROWTYPE;
  _ids uuid[];
  _found int;
  _left bigint;
  _applied bigint := 0;
  _take bigint;
  _row record;
  _paid jsonb;
  _allocations jsonb := '[]'::jsonb;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to confirm a collection' USING ERRCODE = '42501';
  END IF;

  -- Locked, so two people confirming at once are one confirmation and one
  -- "already confirmed", never two sets of payments.
  SELECT * INTO _fc FROM public.field_collections WHERE id = _collection_id FOR UPDATE;
  IF _fc.id IS NULL
     OR NOT public.has_permission(_uid, _fc.organization_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Only someone who manages billing can confirm a collection' USING ERRCODE = '42501';
  END IF;
  IF _fc.status <> 'awaiting_confirmation' THEN
    RAISE EXCEPTION 'This collection was already %',
      CASE WHEN _fc.status = 'confirmed' THEN 'confirmed' ELSE 'rejected' END
      USING ERRCODE = '22023';
  END IF;

  _ids := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(_invoice_ids, '{}'::uuid[])) AS x WHERE x IS NOT NULL);

  SELECT count(*) INTO _found
    FROM public.invoices i
   WHERE i.id = ANY (_ids)
     AND i.organization_id = _fc.organization_id
     AND i.client_id = _fc.client_id
     AND i.status = 'open';
  IF _found <> cardinality(_ids) THEN
    RAISE EXCEPTION 'Only this customer''s open invoices can be paid from this collection' USING ERRCODE = '22023';
  END IF;

  -- Oldest first: that is the debt the customer was most likely paying, and
  -- the order the card lists them in. Each takes what it is owed until the
  -- money runs out; the one where it runs out takes the rest, partly paid.
  -- A ticked invoice the money never reaches is refused rather than silently
  -- skipped: the office asked for it and should hear that it got nothing.
  _left := _fc.amount_cents;
  FOR _row IN
    SELECT i.id,
           GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0)
                    - public.invoice_paid_cents(i.id), 0) AS balance
      FROM public.invoices i
     WHERE i.id = ANY (_ids)
     -- The order the card lists them in (listFieldCollections), so the ticks
     -- read top-down and the money goes where the office sees it going.
     ORDER BY i.period_end, i.issued_at, i.created_at, i.id
  LOOP
    IF _row.balance > 0 AND _left <= 0 THEN
      RAISE EXCEPTION 'Those invoices add up to more than was collected. Untick the newest one'
        USING ERRCODE = '22023';
    END IF;
    _take := LEAST(_left, _row.balance);
    _paid := public.record_invoice_payment(
      _row.id, _take::integer, _fc.method, _fc.reference, _fc.collected_at, NULL, _fc.id
    );
    _left := _left - _take;
    _applied := _applied + _take;
    _allocations := _allocations || jsonb_build_array(_paid);
  END LOOP;

  UPDATE public.field_collections
     SET status = 'confirmed',
         applied_invoice_ids = _ids,
         applied_cents = _applied,
         decided_by_user_id = _uid,
         decided_at = now()
   WHERE id = _fc.id;

  RETURN jsonb_build_object(
    'id', _fc.id,
    'organization_id', _fc.organization_id,
    'client_id', _fc.client_id,
    'amount_cents', _fc.amount_cents,
    'applied_cents', _applied,
    'invoice_ids', to_jsonb(_ids),
    'allocations', _allocations,
    'method', _fc.method,
    'reference', _fc.reference,
    'collected_at', _fc.collected_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_field_collection(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_field_collection(uuid, uuid[]) TO authenticated, service_role;

-- ── 4. The balance, everywhere else it was computed in SQL ──────────────────
--
-- Each below is the latest definition, copied whole, with
-- `- COALESCE(i.amount_paid_cents, 0)` added to its balance and nothing else
-- changed (apply_credit_to_invoice also names the invoice by number in its
-- ledger note, and one comment in franchise_rollup loses an em dash).
-- tests/a-check-for-less-than-the-bill.test.ts diffs each copy against its
-- source to hold that.

CREATE OR REPLACE FUNCTION public.record_field_collection(
  _visit_id uuid,
  _amount_cents integer,
  _method text,
  _reference text DEFAULT NULL,
  _client_key uuid DEFAULT NULL,
  _collected_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _v record;
  _staff record;
  _today date;
  _existing uuid;
  _open bigint;
  _waiting bigint;
  _ref text;
  _at timestamptz;
  _id uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to record a collection' USING ERRCODE = '42501';
  END IF;

  SELECT v.id, v.organization_id, v.client_id, v.assigned_staff_id, v.scheduled_on, v.status,
         COALESCE(NULLIF(o.timezone, ''), 'America/Chicago') AS tz
    INTO _v
    FROM public.visits v
    JOIN public.organizations o ON o.id = v.organization_id
   WHERE v.id = _visit_id;

  -- One message for "no such visit" and "not yours", so the function cannot
  -- be used to ask whether a visit id exists in somebody else's business.
  SELECT s.id, s.display_name INTO _staff
    FROM public.staff s
   WHERE _v.id IS NOT NULL
     AND s.id = _v.assigned_staff_id
     AND s.user_id = _uid
     AND s.organization_id = _v.organization_id
     AND s.active;
  IF _staff.id IS NULL OR NOT public.is_org_member(_uid, _v.organization_id) THEN
    RAISE EXCEPTION 'You can only record a collection on a visit assigned to you' USING ERRCODE = '42501';
  END IF;

  IF _v.status = 'canceled' THEN
    RAISE EXCEPTION 'This visit was canceled' USING ERRCODE = '22023';
  END IF;

  -- Today or the last three days of the org's calendar: long enough for a
  -- collection queued in a dead zone on Friday to replay on Monday morning,
  -- short enough that nobody records last month's cash against a visit.
  _today := (now() AT TIME ZONE _v.tz)::date;
  IF _v.scheduled_on > _today OR _v.scheduled_on < _today - 3 THEN
    RAISE EXCEPTION 'A collection can only be recorded on a visit from the last few days' USING ERRCODE = '22023';
  END IF;

  IF _method IS NULL OR _method NOT IN ('cash', 'check') THEN
    RAISE EXCEPTION 'A collection is cash or a check' USING ERRCODE = '22023';
  END IF;
  _ref := CASE WHEN _method = 'check' THEN NULLIF(btrim(COALESCE(_reference, '')), '') END;
  IF _ref IS NOT NULL AND char_length(_ref) > 120 THEN
    RAISE EXCEPTION 'That check number is too long' USING ERRCODE = '22023';
  END IF;
  IF _amount_cents IS NULL OR _amount_cents <= 0 THEN
    RAISE EXCEPTION 'Enter the amount you collected' USING ERRCODE = '22023';
  END IF;

  -- One customer at a time, so two collections recorded at once cannot both
  -- read the same balance and together exceed it.
  PERFORM pg_advisory_xact_lock(hashtextextended('field_collections:' || _v.client_id::text, 0));

  -- A replay of a request that landed: same key, same answer.
  IF _client_key IS NOT NULL THEN
    SELECT fc.id INTO _existing
      FROM public.field_collections fc
     WHERE fc.client_key = _client_key;
    IF _existing IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.field_collections fc
         WHERE fc.id = _existing AND fc.visit_id = _visit_id AND fc.collected_by_staff_id = _staff.id
      ) THEN
        RAISE EXCEPTION 'That collection belongs to a different visit' USING ERRCODE = '42501';
      END IF;
      RETURN _existing;
    END IF;
  END IF;

  -- A double tap, or an older build's replay with no key: the same visit,
  -- amount and method from the same tech within ten minutes is one collection.
  SELECT fc.id INTO _existing
    FROM public.field_collections fc
   WHERE fc.visit_id = _visit_id
     AND fc.collected_by_staff_id = _staff.id
     AND fc.amount_cents = _amount_cents
     AND fc.method = _method
     AND fc.status = 'awaiting_confirmation'
     AND fc.created_at > now() - interval '10 minutes'
   ORDER BY fc.created_at DESC
   LIMIT 1;
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;

  -- No more than the customer owes, less what is already waiting.
  SELECT COALESCE(sum(GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0) - COALESCE(i.amount_paid_cents, 0), 0)), 0)
    INTO _open
    FROM public.invoices i
   WHERE i.client_id = _v.client_id
     AND i.organization_id = _v.organization_id
     AND i.status = 'open';
  SELECT COALESCE(sum(fc.amount_cents), 0) INTO _waiting
    FROM public.field_collections fc
   WHERE fc.client_id = _v.client_id
     AND fc.status = 'awaiting_confirmation';
  IF _amount_cents > _open - _waiting THEN
    RAISE EXCEPTION 'That is more than this customer owes (%)',
      '$' || to_char(GREATEST(_open - _waiting, 0) / 100.0, 'FM999,999,990.00')
      USING ERRCODE = '22023';
  END IF;

  -- The phone's clock is a hint: inside the last seven days and not in the
  -- future, or it is now.
  _at := CASE
    WHEN _collected_at IS NULL OR _collected_at > now() OR _collected_at < now() - interval '7 days'
      THEN now()
    ELSE _collected_at
  END;

  INSERT INTO public.field_collections (
    organization_id, client_id, visit_id, collected_by_staff_id,
    amount_cents, method, reference, collected_at, client_key
  ) VALUES (
    _v.organization_id, _v.client_id, _visit_id, _staff.id,
    _amount_cents, _method, _ref, _at, _client_key
  )
  RETURNING id INTO _id;

  -- Nobody is told HERE any more. The owner and office managers are told by
  -- recordFieldCollection (src/lib/field-collections.functions.ts) through
  -- notifyRoles, which is the only path that also pushes to their phones, and
  -- whose event key ('field_collection:' || this id) makes a replay of this
  -- call -- which returns the same id -- tell nobody twice.

  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_field_collection(uuid, integer, text, text, uuid, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_field_collection(uuid, integer, text, text, uuid, timestamptz)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.my_day_stop_facts(_visit_ids uuid[])
RETURNS TABLE (
  visit_id uuid,
  dog_count integer,
  autopay boolean,
  card_on_file boolean,
  pays_cash_check boolean,
  open_balance_cents bigint,
  awaiting_cents bigint,
  has_invoice_line boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH allowed AS (
    SELECT v.id, v.organization_id, v.client_id, v.subscription_id
      FROM public.visits v
     WHERE v.id = ANY (_visit_ids)
       AND auth.uid() IS NOT NULL
       AND (
         EXISTS (
           SELECT 1 FROM public.staff s
            WHERE s.id = v.assigned_staff_id
              AND s.user_id = auth.uid() AND s.active
              AND s.organization_id = v.organization_id
         )
         OR public.has_permission(auth.uid(), v.organization_id, 'view_client_directory')
       )
  )
  SELECT a.id,
         sub.dog_count,
         COALESCE(c.autopay_enabled AND NOT c.autopay_paused, false),
         c.default_payment_method_id IS NOT NULL,
         COALESCE((
           SELECT p.method IN ('cash', 'check')
             FROM public.payments p
             JOIN public.invoices i ON i.id = p.invoice_id
            WHERE i.client_id = a.client_id
              AND p.organization_id = a.organization_id
              AND p.status = 'succeeded'
            ORDER BY p.paid_at DESC NULLS LAST, p.created_at DESC
            LIMIT 1
         ), false)
         OR EXISTS (
           SELECT 1 FROM public.field_collections fc
            WHERE fc.client_id = a.client_id
              AND fc.status <> 'rejected'
              AND fc.collected_at > now() - interval '120 days'
         ),
         COALESCE((
           SELECT sum(GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0) - COALESCE(i.amount_paid_cents, 0), 0))
             FROM public.invoices i
            WHERE i.client_id = a.client_id
              AND i.organization_id = a.organization_id
              AND i.status = 'open'
         ), 0)::bigint,
         COALESCE((
           SELECT sum(fc.amount_cents)
             FROM public.field_collections fc
            WHERE fc.client_id = a.client_id
              AND fc.status = 'awaiting_confirmation'
         ), 0)::bigint,
         EXISTS (
           SELECT 1 FROM public.invoice_line_items li
             JOIN public.invoices i ON i.id = li.invoice_id
            WHERE li.visit_id = a.id
              AND i.organization_id = a.organization_id
              AND i.client_id = a.client_id
              AND i.status <> 'void'
         )
    FROM allowed a
    JOIN public.clients c ON c.id = a.client_id
    LEFT JOIN public.subscriptions sub ON sub.id = a.subscription_id
$function$;

REVOKE ALL ON FUNCTION public.my_day_stop_facts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_day_stop_facts(uuid[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.franchise_rollup(_parent_org uuid)
RETURNS TABLE(organization_id uuid, organization_name text, active_clients integer, visits_today integer, visits_completed_today integer, revenue_mtd_cents bigint, revenue_mtd_gross_cents bigint, refunds_mtd_cents bigint, ar_open_cents bigint, tech_count integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _parent_org, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), _parent_org, 'office_manager'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view franchise rollup';
  END IF;

  -- BUILD-1: the role check settled WHO may act; this settles whether the
  -- organization bought the capability. See the header.
  IF NOT public.has_plan_entitlement(_parent_org, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent_org));
  END IF;

  RETURN QUERY
  WITH children AS (
    -- Includes the parent's own row, so a rollup reads as the whole franchise
    -- rather than "everyone but me".
    SELECT o.id, o.name, coalesce(o.timezone, 'America/Chicago') AS tz
    FROM public.organizations o
    WHERE o.id = _parent_org OR o.parent_organization_id = _parent_org
  ),
  clock AS (
    -- Each row's own day and its own month, rather than the parent's imposed on
    -- everyone. `now()` is evaluated once per statement, so every row is cut
    -- from the same instant; only the zone differs, which is the whole point.
    SELECT c.id, c.name, c.tz,
           (now() AT TIME ZONE c.tz)::date AS today,
           (date_trunc('month', (now() AT TIME ZONE c.tz)) AT TIME ZONE c.tz) AS month_start
    FROM children c
  ),
  money AS (
    SELECT c.id,
           COALESCE((SELECT SUM(p.amount_cents)::bigint FROM public.payments p
                      WHERE p.organization_id = c.id
                        AND p.status IN ('succeeded', 'refunded')
                        AND p.created_at >= c.month_start), 0) AS gross,
           COALESCE((SELECT SUM(
                       CASE WHEN ri.kind = 'payment_chargeback_won'
                            THEN -COALESCE((ri.detail->>'revenue_cents')::bigint, (ri.detail->>'amount_cents')::bigint)
                            ELSE  COALESCE((ri.detail->>'revenue_cents')::bigint, (ri.detail->>'amount_cents')::bigint) END
                     )::bigint
                       FROM public.review_items ri
                      WHERE ri.organization_id = c.id
                        AND ri.kind IN ('payment_refunded','payment_chargeback','payment_chargeback_won')
                        AND ri.detected_at >= c.month_start), 0) AS refunds
    FROM clock c
  )
  SELECT
    c.id,
    c.name,
    COALESCE((SELECT COUNT(*)::int FROM public.clients cl
               WHERE cl.organization_id = c.id AND cl.active = true), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v
               WHERE v.organization_id = c.id AND v.scheduled_on = c.today), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v
               WHERE v.organization_id = c.id AND v.scheduled_on = c.today
                 AND v.status = 'completed'), 0),
    (m.gross - m.refunds)::bigint,
    m.gross,
    m.refunds,
    COALESCE((SELECT SUM(GREATEST(i.total_cents - COALESCE(i.credit_applied_cents, 0) - COALESCE(i.amount_paid_cents, 0), 0))::bigint
                FROM public.invoices i
               WHERE i.organization_id = c.id AND i.status = 'open'), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.staff s
               WHERE s.organization_id = c.id AND s.active = true), 0)
  FROM clock c JOIN money m ON m.id = c.id
  ORDER BY (c.id = _parent_org) DESC, c.name;
END;
$function$;

REVOKE ALL ON FUNCTION public.franchise_rollup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_rollup(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_credit_to_invoice(_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _inv record;
  _balance integer;
  _open integer;
  _apply integer;
  _fully boolean;
BEGIN
  -- Serialize with the billing engine and with double-submitted staff clicks.
  PERFORM pg_advisory_xact_lock(hashtext('credit-apply:' || _invoice_id::text));

  SELECT * INTO _inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF auth.uid() IS NOT NULL
     AND NOT public.has_permission(auth.uid(), _inv.organization_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  _open := GREATEST(COALESCE(_inv.total_cents, 0) - COALESCE(_inv.credit_applied_cents, 0) - COALESCE(_inv.amount_paid_cents, 0), 0);

  IF _inv.status <> 'open' THEN
    RETURN jsonb_build_object(
      'applied_cents', 0,
      'remaining_due_cents', CASE WHEN _inv.status = 'draft' THEN _open ELSE 0 END,
      'invoice_status', _inv.status,
      'reason', 'not_open');
  END IF;

  -- Applying credit to a prepaid top-up would be circular: paying a top-up
  -- grants credit (tg_invoice_paid_credit), so credit would buy itself back.
  IF _inv.kind = 'prepaid_topup' THEN
    RETURN jsonb_build_object(
      'applied_cents', 0,
      'remaining_due_cents', _open,
      'invoice_status', _inv.status,
      'reason', 'prepaid_topup');
  END IF;

  IF _open <= 0 THEN
    RETURN jsonb_build_object(
      'applied_cents', 0,
      'remaining_due_cents', 0,
      'invoice_status', _inv.status,
      'reason', 'nothing_due');
  END IF;

  -- Lock the client row so a concurrent application can't double-spend the
  -- same balance.
  SELECT credit_balance_cents INTO _balance
    FROM public.clients WHERE id = _inv.client_id FOR UPDATE;

  _apply := LEAST(GREATEST(COALESCE(_balance, 0), 0), _open);
  IF _apply <= 0 THEN
    RETURN jsonb_build_object(
      'applied_cents', 0,
      'remaining_due_cents', _open,
      'invoice_status', _inv.status,
      'reason', 'no_credit');
  END IF;

  _fully := (_apply >= _open);

  PERFORM public.post_credit_entry(
    _inv.organization_id, _inv.client_id, -_apply, 'invoice_application',
    _invoice_id, NULL,
    'Applied to invoice ' || CASE WHEN _inv.number IS NOT NULL THEN 'INV-' || _inv.number ELSE '#' || left(_invoice_id::text, 8) END);

  -- Deliberately NO payments row: payments is the cash ledger and credit
  -- application moves no new cash (see migration header).

  UPDATE public.invoices
     SET credit_applied_cents = COALESCE(credit_applied_cents, 0) + _apply,
         status  = CASE WHEN _fully THEN 'paid'::public.invoice_status ELSE status END,
         paid_at = CASE WHEN _fully THEN now() ELSE paid_at END,
         updated_at = now()
   WHERE id = _invoice_id;

  RETURN jsonb_build_object(
    'applied_cents', _apply,
    'remaining_due_cents', _open - _apply,
    'invoice_status', CASE WHEN _fully THEN 'paid' ELSE 'open' END,
    'reason', 'applied');
END;
$$;

REVOKE ALL ON FUNCTION public.apply_credit_to_invoice(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_credit_to_invoice(uuid) TO authenticated, service_role;

-- ── What this file establishes ──────────────────────────────────────────────

DO $check$
DECLARE
  _drift int;
  _open_with_money int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'amount_paid_cents'
  ) THEN
    RAISE EXCEPTION 'invoices.amount_paid_cents was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payments_sync_invoice_paid'
                  AND tgrelid = 'public.payments'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'payments_sync_invoice_paid is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invoices_guard_amount_paid'
                  AND tgrelid = 'public.invoices'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'invoices_guard_amount_paid is missing';
  END IF;
  -- touch_invoices was disabled for the backfill; it must be back on.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'touch_invoices'
              AND tgrelid = 'public.invoices'::regclass AND tgenabled = 'D') THEN
    RAISE EXCEPTION 'touch_invoices was left disabled';
  END IF;

  IF has_function_privilege('anon',
       'public.record_invoice_payment(uuid, integer, text, text, timestamptz, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can record a payment';
  END IF;
  IF has_function_privilege('authenticated', 'public.sync_invoice_amount_paid(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.sync_invoice_amount_paid(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'sync_invoice_amount_paid is callable from the API';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
           WHERE oid = 'public.record_invoice_payment(uuid, integer, text, text, timestamptz, text, uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'record_invoice_payment is not SECURITY DEFINER';
  END IF;

  -- Every copied balance subtracts what was paid. prosrc, named: no
  -- pg_get_functiondef over a set.
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.record_field_collection(uuid, integer, text, text, uuid, timestamptz)'::regprocedure) NOT LIKE '%amount_paid_cents%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.my_day_stop_facts(uuid[])'::regprocedure) NOT LIKE '%amount_paid_cents%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.franchise_rollup(uuid)'::regprocedure) NOT LIKE '%amount_paid_cents%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.apply_credit_to_invoice(uuid)'::regprocedure) NOT LIKE '%amount_paid_cents%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.confirm_field_collection(uuid, uuid[])'::regprocedure) NOT LIKE '%record_invoice_payment%' THEN
    RAISE EXCEPTION 'a balance in SQL still ignores amount_paid_cents';
  END IF;

  -- The backfill agrees with the ledger, on whatever rows exist.
  SELECT count(*) INTO _drift
    FROM public.invoices i
   WHERE i.amount_paid_cents <> public.invoice_paid_cents(i.id);
  IF _drift > 0 THEN
    RAISE EXCEPTION '% invoices disagree with their payments after the backfill', _drift;
  END IF;

  -- A measured number, not an assertion: open invoices that already carried a
  -- succeeded payment. Their balance drops by it from today. Printed so
  -- somebody reads it.
  SELECT count(*) INTO _open_with_money
    FROM public.invoices i
   WHERE i.status = 'open' AND i.amount_paid_cents > 0;
  RAISE WARNING 'open invoices that already had money against them (balance now net of it): %', _open_with_money;
END;
$check$;
