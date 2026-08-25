-- No technician could complete a prepaid customer's visit, and the failure
-- looked like a permissions bug in the app.
--
-- ── CONFIRMED, NOT INFERRED ───────────────────────────────────────────────
--
-- Run against production on 2026-08-25 as a real technician, on a real prepaid
-- visit, inside a block that aborts unconditionally so nothing could commit:
--
--   PROBE RESULT >> state=42501 :: msg=Not authorized for this organization.
--
-- 42501 is insufficient_privilege, and that message is the one raised below by
-- post_credit_entry. The RPC was actually called; this is not a reading of the
-- source.
--
-- ── THE MECHANISM ─────────────────────────────────────────────────────────
--
-- 20260820140000 closed a real hole: a tech could put money on a customer's
-- account. It replaced is_org_member with has_permission(…,
-- 'manage_client_billing') inside post_credit_entry, guarded by
-- `IF auth.uid() IS NOT NULL`, and its header reasoned that service-role
-- callers "run with auth.uid() NULL and are exempted".
--
-- That premise is right about the service role and wrong about one caller.
-- finalize_visit_completion (20260729100000, line 56) is SECURITY DEFINER, and
-- SECURITY DEFINER changes the privilege ROLE — it does not touch
-- request.jwt.claims, which is what auth.uid() reads. So inside it, auth.uid()
-- is still the technician's. When a tech completes a visit whose subscription
-- is prepaid with a price above zero, line 72 posts the visit debit, the guard
-- sees a tech, and the whole completion transaction rolls back.
--
-- A tech's only permission is record_field_addons (src/lib/permissions.ts:54),
-- so no technician anywhere can satisfy it. Measured in production the same
-- day, across the three organizations that have prepaid subscriptions:
--
--   org                                    techs   any_tech_can_bill
--   05132407-765b-4f41-a98a-0fd8f7068013     2         false
--   342d4d1e-56f7-4b6e-ad40-524d370e1a36     3         false
--   afaaa8bc-e182-4b45-ac3b-7c60e2d38057     2         false
--
-- ── WHY THIS WAS NOT AN OUTAGE, AND STILL MATTERS ────────────────────────
--
-- No visit of any cadence has been completed since 2026-08-04 — sixteen days
-- BEFORE the change landed — so nobody has hit it. It is not five days of
-- silent failure; it is 313 prepaid visits sitting in `scheduled` across those
-- three organizations, every one of which fails the moment a tech taps
-- Complete. Loaded, not fired.
--
-- ── THE FIX, AND WHY IT IS THIS SHAPE ────────────────────────────────────
--
-- The threat 20260820140000 was written against is a technician ADDING credit
-- to a customer's account. The debit posted by finalize_visit_completion is
-- the opposite thing: a negative, mechanical consequence of completing work
-- the technician is already authorized to complete, keyed to a specific visit
-- that is already assigned to them. Refusing that is not the protection, it is
-- collateral.
--
-- So the exemption is written as narrowly as the sentence above:
--
--   * the kind must be exactly 'visit_debit'
--   * the amount must be NEGATIVE — a tech can never move a balance UP
--   * a visit id is required
--   * that visit must belong to the org being named
--   * and it must be assigned to a staff row whose user_id is the caller
--
-- Every other route into this function is unchanged. addClientCredit still
-- requires manage_client_billing. A tech naming another tech's visit fails the
-- assignment test. A tech naming a positive delta fails the sign test. A tech
-- crediting with no visit fails the not-null test. The cross-tenant client
-- check that the 2026-08-20 file added is preserved and now runs on BOTH
-- branches rather than only the permitted one.
--
-- Deliberately NOT done: granting techs manage_client_billing (it would let
-- them add credit, which is the original hole), and dropping the guard back to
-- is_org_member (same). Also not done: a transaction-local flag set by
-- finalize_visit_completion, which would have worked but makes the permission
-- depend on invisible state rather than on the arguments in front of it.

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
    -- The mechanical debit a technician's own completion posts. See header:
    -- negative only, this kind only, and only for a visit already assigned to
    -- the caller.
    _is_own_visit_debit := (
      _kind = 'visit_debit'
      AND _delta < 0
      AND _visit_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM public.visits v
          JOIN public.staff s ON s.id = v.assigned_staff_id
         WHERE v.id = _visit_id
           AND v.organization_id = _org_id
           AND v.client_id = _client_id
           AND s.user_id = auth.uid()
      )
    );

    IF NOT _is_own_visit_debit
       AND NOT public.has_permission(auth.uid(), _org_id, 'manage_client_billing') THEN
      RAISE EXCEPTION 'Not authorized for this organization.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Unchanged in intent, moved so it guards the exempt path too: permission
    -- alone still lets a member of one tenant name their own org id and
    -- another tenant's client id, and the balance write is keyed on the client.
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
  -- The balance is maintained by credit_ledger_maintain_balance. Updating it
  -- here as well would double every entry posted through this function.
END;
$function$;

-- Both lines every time, per 20260809180000: CREATE OR REPLACE preserves an
-- existing ACL on production and creates a default one on a fresh replay.
REVOKE ALL ON FUNCTION public.post_credit_entry(uuid, uuid, integer, text, uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_credit_entry(uuid, uuid, integer, text, uuid, uuid, text)
  TO authenticated, service_role;

DO $verify$
DECLARE _src text;
BEGIN
  -- Read prosrc, never pg_get_functiondef over an unbounded set — CLAUDE.md.
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_credit_entry'
   LIMIT 1;

  IF _src IS NULL THEN
    RAISE EXCEPTION 'post_credit_entry is missing after this migration';
  END IF;

  -- What this file ESTABLISHES, provable from any starting state.
  IF _src NOT LIKE '%has_permission%' THEN
    RAISE EXCEPTION 'post_credit_entry no longer consults the permission matrix';
  END IF;
  IF _src NOT LIKE '%_delta < 0%' THEN
    RAISE EXCEPTION 'the visit-debit exemption is not bounded to negative amounts';
  END IF;
  IF _src NOT LIKE '%s.user_id = auth.uid()%' THEN
    RAISE EXCEPTION 'the visit-debit exemption is not bounded to the caller''s own visit';
  END IF;
END
$verify$;
