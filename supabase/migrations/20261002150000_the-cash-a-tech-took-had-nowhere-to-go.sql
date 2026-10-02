-- The cash a tech took had nowhere to go.
--
-- The owner, using the app as a technician on 2026-10-02: "There's nothing to
-- indicate that they paid cash." Nor anything to do about it. A customer hands
-- the tech $40 at the gate and the only place that money could be written down
-- was the office's "Record payment" (#239), which marks whole invoices paid
-- and is gated on manage_client_billing -- correctly, because a tech who can
-- mark invoices paid can make any balance disappear. So the cash went into a
-- pocket and the office found out when somebody remembered to say.
--
-- Three things, and one of them is deliberately NOT a payment.
--
-- 1. field_collections: what the tech says they took -- amount, cash or check,
--    the check number, when. It is a CLAIM, waiting for the office, not money
--    applied to anything. Not a `payments` row in a pending state, because
--    payments is what revenue, the cash-basis reports, the franchise royalty
--    base, the accounting sync (accounting_remote_id) and the outgoing
--    webhooks all read, and every one of them would have to learn to skip a
--    row the office has not looked at. A separate table cannot leak into a
--    total by being forgotten. And payments.invoice_id is NOT NULL, while
--    cash at a gate is paid against a balance, not an invoice the tech
--    cannot see.
--
--    A tech writes one only through record_field_collection, for a visit
--    assigned to THEIR OWN staff row, scheduled within the last three days of
--    the org's calendar, for an amount above zero and no more than the
--    customer's open balance less what is already waiting. Idempotent twice
--    over, because the offline queue replays after an 8-second deadline that
--    does not cancel the first request: by the client-minted key, and by the
--    same visit, amount and method from the same tech within ten minutes. The
--    owner and office managers are notified (type 'field_collection', mutable
--    like every other).
--
-- 2. confirm_field_collection: the office's half, manage_client_billing only.
--    It CLAIMS the collection, once, atomically, against invoices that are
--    open, the same customer's, and add up to no more than was collected. It
--    applies no money itself. The server function then hands those invoices
--    to bulkMarkInvoicesPaid -- the very path "Record payment" uses -- with the
--    collection's method, check number and day, so a field collection becomes
--    exactly the payment rows, activity entries and pay-page cancellations an
--    office-recorded check would. The invoice model has no partial payments;
--    a collection that settles no whole invoice can be confirmed with none,
--    and stays visible as unapplied rather than being forced onto one.
--    reject_field_collection is the "that never happened" answer.
--
-- 3. my_day_stop_facts: what a stop card needs from tables a tech cannot read
--    -- the dog count the subscription is priced on, autopay and card on
--    file, whether the last payment was cash or a check, the open balance and
--    what is already waiting. Only for visits assigned to the caller, or for
--    an office role previewing a tech's day (view_client_directory, the gate
--    the client list with its balances already uses).
--
-- Replays into an empty database: a table, its policies, four functions. The
-- DO block asserts what this file establishes and needs no tenant or row.

-- ── 1. The claim ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.field_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  visit_id uuid REFERENCES public.visits(id) ON DELETE SET NULL,
  collected_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL,
  method text NOT NULL,
  reference text,
  -- When the tech had the money in hand, which for a replayed action is the
  -- time they tapped, bounded by the function to the last seven days.
  collected_at timestamptz NOT NULL DEFAULT now(),
  -- Minted on the device, carried by the queued action, so a replay of a
  -- request that DID land finds its own row instead of making a second.
  client_key uuid,
  status text NOT NULL DEFAULT 'awaiting_confirmation',
  applied_invoice_ids uuid[] NOT NULL DEFAULT '{}',
  applied_cents integer NOT NULL DEFAULT 0,
  decided_by_user_id uuid,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_collections_amount_range CHECK (amount_cents > 0 AND amount_cents <= 10000000),
  CONSTRAINT field_collections_method_check CHECK (method IN ('cash', 'check')),
  CONSTRAINT field_collections_reference_check
    CHECK (reference IS NULL OR (method = 'check' AND char_length(reference) <= 120)),
  CONSTRAINT field_collections_status_check
    CHECK (status IN ('awaiting_confirmation', 'confirmed', 'rejected')),
  CONSTRAINT field_collections_decided_check
    CHECK ((status = 'awaiting_confirmation') = (decided_at IS NULL)),
  CONSTRAINT field_collections_applied_check
    CHECK (applied_cents >= 0 AND applied_cents <= amount_cents
           AND (status = 'confirmed' OR (applied_cents = 0 AND applied_invoice_ids = '{}'))),
  CONSTRAINT field_collections_note_length CHECK (decision_note IS NULL OR char_length(decision_note) <= 500)
);

COMMENT ON TABLE public.field_collections IS
  'Cash or a check a technician says they collected at a stop, waiting for the office. Not a payment: confirm_field_collection claims it against open invoices and bulkMarkInvoicesPaid then records the payments the way the office''s Record payment does. Written only through record_field_collection.';

CREATE UNIQUE INDEX IF NOT EXISTS field_collections_client_key
  ON public.field_collections (client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS field_collections_org_status
  ON public.field_collections (organization_id, status, collected_at DESC);
CREATE INDEX IF NOT EXISTS field_collections_client_id
  ON public.field_collections (client_id, status);
CREATE INDEX IF NOT EXISTS field_collections_visit_id
  ON public.field_collections (visit_id);
CREATE INDEX IF NOT EXISTS field_collections_collected_by_staff_id
  ON public.field_collections (collected_by_staff_id);

ALTER TABLE public.field_collections ENABLE ROW LEVEL SECURITY;

-- Read-only to the API. Every write is one of the functions below, which is
-- what lets the rules live in one place: no INSERT for a tech to forge a
-- confirmed row with, no UPDATE for anyone to flip a status by hand.
REVOKE ALL ON public.field_collections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.field_collections TO authenticated;
GRANT ALL ON public.field_collections TO service_role;

-- The office's money roles see the org's; a tech sees what they recorded, so
-- the card can say "waiting for the office" about their own collection.
DROP POLICY IF EXISTS "field collections: billing roles, or whoever collected (select)" ON public.field_collections;
CREATE POLICY "field collections: billing roles, or whoever collected (select)" ON public.field_collections
  FOR SELECT TO authenticated
  USING (
    public.has_permission((SELECT auth.uid()), organization_id, 'manage_client_billing')
    OR public.has_permission((SELECT auth.uid()), organization_id, 'view_financials')
    OR collected_by_staff_id IN (SELECT s.id FROM public.staff s WHERE s.user_id = (SELECT auth.uid()))
  );

-- ── The tech's side ─────────────────────────────────────────────────────────

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
  _client_name text;
  _how text;
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
  SELECT COALESCE(sum(GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0), 0)), 0)
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

  -- Tell the people who can confirm it, unless they muted the type.
  SELECT c.display_name INTO _client_name FROM public.clients c WHERE c.id = _v.client_id;
  _how := CASE WHEN _method = 'cash' THEN 'cash'
               WHEN _ref IS NOT NULL THEN 'check #' || _ref
               ELSE 'a check' END;
  INSERT INTO public.app_notifications (organization_id, recipient_user_id, type, title, body, link)
  SELECT _v.organization_id, ur.user_id, 'field_collection',
         btrim(_staff.display_name) || ' collected '
           || '$' || to_char(_amount_cents / 100.0, 'FM999,999,990.00') || ' (' || _how || ')',
         'From ' || COALESCE(_client_name, 'a customer')
           || '. Confirm it on Invoices to apply it to their open invoices.',
         '/invoices'
    FROM public.user_roles ur
   WHERE ur.organization_id = _v.organization_id
     AND ur.role IN ('owner', 'office_manager')
     AND NOT EXISTS (
       SELECT 1 FROM public.app_notification_prefs p
        WHERE p.user_id = ur.user_id AND 'field_collection' = ANY (p.muted_types)
     );

  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_field_collection(uuid, integer, text, text, uuid, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_field_collection(uuid, integer, text, text, uuid, timestamptz)
  TO authenticated, service_role;

-- ── 2. The office's side ────────────────────────────────────────────────────

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
  _applied bigint;
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

  SELECT count(*), COALESCE(sum(GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0), 0)), 0)
    INTO _found, _applied
    FROM public.invoices i
   WHERE i.id = ANY (_ids)
     AND i.organization_id = _fc.organization_id
     AND i.client_id = _fc.client_id
     AND i.status = 'open';
  IF _found <> cardinality(_ids) THEN
    RAISE EXCEPTION 'Only this customer''s open invoices can be paid from this collection' USING ERRCODE = '22023';
  END IF;
  IF _applied > _fc.amount_cents THEN
    RAISE EXCEPTION 'Those invoices add up to more than was collected' USING ERRCODE = '22023';
  END IF;

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
    'method', _fc.method,
    'reference', _fc.reference,
    'collected_at', _fc.collected_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_field_collection(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_field_collection(uuid, uuid[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reject_field_collection(
  _collection_id uuid,
  _note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _fc public.field_collections%ROWTYPE;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to reject a collection' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _fc FROM public.field_collections WHERE id = _collection_id FOR UPDATE;
  IF _fc.id IS NULL
     OR NOT public.has_permission(_uid, _fc.organization_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Only someone who manages billing can reject a collection' USING ERRCODE = '42501';
  END IF;
  IF _fc.status <> 'awaiting_confirmation' THEN
    RAISE EXCEPTION 'This collection was already decided' USING ERRCODE = '22023';
  END IF;
  UPDATE public.field_collections
     SET status = 'rejected',
         decided_by_user_id = _uid,
         decided_at = now(),
         decision_note = NULLIF(left(btrim(COALESCE(_note, '')), 500), '')
   WHERE id = _fc.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.reject_field_collection(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_field_collection(uuid, text) TO authenticated, service_role;

-- ── 3. What a stop card needs from tables a tech cannot read ────────────────

CREATE OR REPLACE FUNCTION public.my_day_stop_facts(_visit_ids uuid[])
RETURNS TABLE (
  visit_id uuid,
  dog_count integer,
  autopay boolean,
  card_on_file boolean,
  pays_cash_check boolean,
  open_balance_cents bigint,
  awaiting_cents bigint
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
              AND s.user_id = auth.uid()
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
           SELECT sum(GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0), 0))
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
         ), 0)::bigint
    FROM allowed a
    JOIN public.clients c ON c.id = a.client_id
    LEFT JOIN public.subscriptions sub ON sub.id = a.subscription_id
$function$;

REVOKE ALL ON FUNCTION public.my_day_stop_facts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_day_stop_facts(uuid[]) TO authenticated, service_role;

-- ── What this file establishes ──────────────────────────────────────────────

DO $check$
DECLARE
  _fn regprocedure;
  _fk record;
BEGIN
  IF to_regclass('public.field_collections') IS NULL THEN
    RAISE EXCEPTION 'field_collections was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.field_collections'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on field_collections';
  END IF;
  IF has_table_privilege('anon', 'public.field_collections', 'SELECT')
     OR has_table_privilege('anon', 'public.field_collections', 'INSERT') THEN
    RAISE EXCEPTION 'anon holds a privilege on field_collections';
  END IF;
  IF has_table_privilege('authenticated', 'public.field_collections', 'INSERT')
     OR has_table_privilege('authenticated', 'public.field_collections', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.field_collections', 'DELETE')
     OR has_table_privilege('authenticated', 'public.field_collections', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated can write field_collections directly, past record_field_collection';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'field_collections' AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'field_collections has a write policy; every write is a function';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'field_collections'
       AND indexdef ILIKE '%UNIQUE%client_key%'
  ) THEN
    RAISE EXCEPTION 'field_collections.client_key is not unique, so a replay can record twice';
  END IF;

  FOR _fk IN
    SELECT c.conname, c.conkey FROM pg_constraint c
     WHERE c.conrelid = 'public.field_collections'::regclass AND c.contype = 'f'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = 'public.field_collections'::regclass
         AND i.indkey[0] = _fk.conkey[1]
    ) THEN
      RAISE EXCEPTION 'foreign key % on field_collections has no index', _fk.conname;
    END IF;
  END LOOP;

  FOREACH _fn IN ARRAY ARRAY[
    'public.record_field_collection(uuid, integer, text, text, uuid, timestamptz)'::regprocedure,
    'public.confirm_field_collection(uuid, uuid[])'::regprocedure,
    'public.reject_field_collection(uuid, text)'::regprocedure,
    'public.my_day_stop_facts(uuid[])'::regprocedure
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon', _fn;
    END IF;
    IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not executable by authenticated', _fn;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = _fn) THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER: the tables it reads or writes are closed to its caller', _fn;
    END IF;
  END LOOP;

  -- The office's two functions ask the permission matrix, not membership.
  IF position('manage_client_billing' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public.confirm_field_collection(uuid, uuid[])'::regprocedure)) = 0
     OR position('manage_client_billing' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public.reject_field_collection(uuid, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'confirming or rejecting a collection does not require manage_client_billing';
  END IF;
END
$check$;
