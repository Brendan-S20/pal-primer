-- The exemption said WHICH visit and WHICH direction, and not how much or how
-- often.
--
-- ── WHAT 20260825070000 LEFT OPEN ─────────────────────────────────────────
--
-- That migration let a technician's own completion post its visit debit, which
-- it has to: post_credit_entry runs with the tech's auth.uid() even inside a
-- SECURITY DEFINER caller, and requiring manage_client_billing there meant no
-- tech could complete a prepaid visit at all.
--
-- The exemption it added requires the kind to be 'visit_debit', the amount to
-- be NEGATIVE, and the visit to be assigned to the caller. Three of the four
-- questions. It never asked HOW MUCH, and it never asked WHETHER THIS VISIT
-- HAD ALREADY BEEN DEBITED.
--
-- post_credit_entry is EXECUTE-able by `authenticated`, so a technician holding
-- one assigned visit could call it directly against PostgREST with
-- `_delta = -500000`, or call it two hundred times with the real amount, and
-- drain that client's prepaid balance. credit_ledger has no unique index that
-- would stop the repeat (only credit_ledger_one_promo_per_client, which is
-- about promos), and credit_ledger_maintain_balance is a balance maintainer,
-- not a guard.
--
-- Narrower than the hole it replaced, and fully attributable in the ledger --
-- theft with a paper trail rather than a silent one. Still a hole.
--
-- ── WHAT THE LEGITIMATE CALL ACTUALLY LOOKS LIKE ──────────────────────────
--
-- finalize_visit_completion (20260729100000, line 72) posts exactly one thing:
--
--     PERFORM public.post_credit_entry(
--       _org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed')
--
-- where `_price` is `subscriptions.price_cents` for THAT visit's subscription,
-- and complete_visit's `IF NOT FOUND THEN RETURN` guard means a second
-- concurrent completion cannot reach it. So the exempt call is fully
-- determined: one entry, per visit, for exactly the subscription price.
--
-- This bounds the exemption to that. The amount must equal the negated
-- subscription price for the named visit, and no visit_debit may already exist
-- for it.
--
-- ── WHY NOT A UNIQUE INDEX ────────────────────────────────────────────────
--
-- A partial unique index on (visit_id) WHERE kind = 'visit_debit' would also
-- stop the repeat, and would do it for every caller including the service role.
-- That is the wrong shape: an operator correcting a bad ledger by hand runs as
-- service role and has always been trusted here, and a constraint that fires on
-- them turns a data-repair session into a migration. The repeat check therefore
-- lives INSIDE the exemption, so it constrains the tech path and nothing else.
--
-- The service role still bypasses all of this via `auth.uid() IS NULL`, exactly
-- as it did before, and manage_client_billing holders are unchanged.

CREATE OR REPLACE FUNCTION public.post_credit_entry(
  _org_id uuid, _client_id uuid, _delta integer, _kind text,
  _invoice_id uuid, _visit_id uuid, _note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _is_own_visit_debit boolean := false;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    -- The one entry a technician's own completion posts: this kind, negative,
    -- their own visit, EXACTLY the subscription price, and only if this visit
    -- has not been debited already. See the header for why each clause is
    -- here -- the first three shipped in 20260825070000, the last two are what
    -- this file adds.
    _is_own_visit_debit := (
      _kind = 'visit_debit'
      AND _delta < 0
      AND _visit_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM public.visits v
          JOIN public.staff s ON s.id = v.assigned_staff_id
          JOIN public.subscriptions sub ON sub.id = v.subscription_id
         WHERE v.id = _visit_id
           AND v.organization_id = _org_id
           AND v.client_id = _client_id
           AND s.user_id = auth.uid()
           -- The amount is not the caller's to choose.
           AND _delta = -sub.price_cents
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.credit_ledger cl
         WHERE cl.visit_id = _visit_id
           AND cl.kind = 'visit_debit'
      )
    );

    IF NOT _is_own_visit_debit
       AND NOT public.has_permission(auth.uid(), _org_id, 'manage_client_billing') THEN
      RAISE EXCEPTION 'Not authorized for this organization.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
       WHERE c.id = _client_id AND c.organization_id = _org_id
    ) THEN
      RAISE EXCEPTION 'Client does not belong to this organization.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, invoice_id, visit_id, note)
  VALUES (_org_id, _client_id, _delta, _kind, _invoice_id, _visit_id, _note);
END;
$function$;

REVOKE ALL ON FUNCTION public.post_credit_entry(uuid, uuid, integer, text, uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_credit_entry(uuid, uuid, integer, text, uuid, uuid, text)
  TO authenticated, service_role;

DO $verify$
DECLARE _src text;
BEGIN
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_credit_entry'
   LIMIT 1;

  IF _src IS NULL THEN
    RAISE EXCEPTION 'post_credit_entry is missing after this migration';
  END IF;
  -- The four bounds this file is about, each asserted by name.
  IF _src NOT LIKE '%_delta < 0%' THEN
    RAISE EXCEPTION 'the exemption is no longer bounded to negative amounts';
  END IF;
  IF _src NOT LIKE '%s.user_id = auth.uid()%' THEN
    RAISE EXCEPTION 'the exemption is no longer bounded to the caller''s own visit';
  END IF;
  IF _src NOT LIKE '%_delta = -sub.price_cents%' THEN
    RAISE EXCEPTION 'the exemption no longer bounds the AMOUNT to the subscription price';
  END IF;
  IF _src NOT LIKE '%NOT EXISTS%visit_debit%' THEN
    RAISE EXCEPTION 'the exemption no longer refuses a second debit for the same visit';
  END IF;
END
$verify$;
