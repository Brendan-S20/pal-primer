-- A technician could put $21 million on a customer's account, and nothing would
-- say who did it.
--
-- post_credit_entry is SECURITY DEFINER, granted to `authenticated`, and gated
-- on MEMBERSHIP rather than permission:
--
--     IF NOT public.is_org_member(auth.uid(), _org_id) THEN
--
-- `is_org_member` admits every role, so any signed-in tech could post an
-- arbitrary credit adjustment against any client in their own organization.
-- `_delta` is an integer with no cap and no sign restriction, and `_kind`
-- accepts all nine ledger kinds -- so a forged `prepayment` is indistinguishable
-- in the ledger UI from a real one.
--
-- PROVEN ON PRODUCTION, in a transaction that was rolled back, holding a tech's
-- JWT claims: post_credit_entry(own org, own client, 500000, 'prepayment') was
-- ALLOWED and the ledger went 92 rows -> 93. The probe then raised to unwind it;
-- the table is back at 92 with no row left behind.
--
-- It does not sit inert once posted. `credit_balance_cents` is recomputed by
-- credit_ledger_maintain_balance, and the `run-billing-cycles` cron job at
-- 06:10 daily reaches apply_credit_to_invoice through
-- admin_generate_invoice_for_client. A credit posted at 4pm is spent against a
-- real invoice by an unattended job the next morning and reported to the
-- accountant as "Credits applied". There is no `created_by` on credit_ledger,
-- and the activity-log entry is written by the TypeScript layer, which this
-- path skips -- so the row carries no trace of who posted it.
--
-- SEVERITY, PLAINLY: same-tenant, not cross-tenant. The 2026-07-31 pass closed
-- the cross-tenant hole correctly and the client-belongs-to-org clause below is
-- untouched. The app path is already gated -- addClientCredit and redeemGiftCard
-- both call requirePermission(..., 'manage_client_billing') first, and the
-- Billing tab is not rendered without it -- so this is reachable only by
-- hand-calling the PostgREST RPC with a session the browser already holds.
--
-- WHY THE MEMBERSHIP CHECK WAS CHOSEN, AND WHY IT DOES NOT SURVIVE HERE.
-- 20260731240000 said so deliberately, lines 62-68:
--
--     "The check is MEMBERSHIP ... not a permission, on purpose. The hole is
--      cross-tenant reach; which roles inside a tenant may see revenue or issue
--      credit is a different question, already answered by requirePermission in
--      the TypeScript layer, and duplicating it here in a weaker form would lock
--      out legitimate roles without closing anything."
--
-- That reasoning holds for the five scalar READS in that migration. It does not
-- hold for this one, because this function keeps its `authenticated` grant and
-- is therefore reachable WITHOUT going through the TypeScript layer that was
-- doing the work. The table underneath already agrees: credit_ledger's own RLS
-- policies are both `has_permission(..., 'manage_client_billing')`, so a tech
-- cannot even read the ledger -- while this SECURITY DEFINER function ran past
-- those policies on nothing but membership.
--
-- Ten of the ten other `authenticated`-reachable money functions require
-- manage_client_billing (apply_credit_to_invoice, apply_referral_code,
-- generate_invoice_for_client, generate_invoices_for_org,
-- generate_prepaid_invoice, redeem_gift_card, void_invoice, void_addon_charge,
-- set_addon_subscription_status, and create_addon_charge's office path). This
-- was the only outlier.
--
-- NOTHING LEGITIMATE BREAKS. Production has 92 ledger rows and ZERO of kind
-- 'adjustment'; the activity log has zero `client.credit_adjusted` entries. No
-- human has ever used the staff-credit path. The sanctioned field money path is
-- create_addon_charge(_source => 'field'), which CHARGES under
-- record_field_addons, is capped, own-visit-only and attributed, and is
-- untouched here. Every internal caller already qualifies: the service_role
-- callers (finalize_visit_completion, tg_invoice_paid_credit,
-- run_billing_cycles) run with auth.uid() NULL and are exempted by the guard
-- below, exactly as before.
--
-- One narrow new failure, called out rather than discovered: a platform admin
-- who holds a tech or dispatcher role row in the org they are reseeding via
-- seed_demo_org would now be refused. They were already refused by
-- is_org_member unless they held a row at all, so the delta is small.
--
-- The `authenticated` GRANT is deliberately left in place: addClientCredit
-- calls this on the user's own session, not the service key.

CREATE OR REPLACE FUNCTION public.post_credit_entry(
  _org_id uuid, _client_id uuid, _delta integer, _kind text,
  _invoice_id uuid, _visit_id uuid, _note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    -- Was is_org_member. Crediting a customer's account is a billing action and
    -- permissions.ts has always said so: manage_client_billing covers
    -- "invoices, add-on charges/subscriptions, void, prepaid, credit".
    IF NOT public.has_permission(auth.uid(), _org_id, 'manage_client_billing') THEN
      RAISE EXCEPTION 'Not authorized for this organization.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Permission alone still lets a member of one tenant name their own org id
    -- and another tenant's client id; the balance write is keyed on the client.
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

-- CREATE OR REPLACE preserves an existing ACL, so on production this changes
-- nothing -- proacl is already {postgres,authenticated,service_role} and anon
-- cannot reach it. It matters on a REPLAY INTO AN EMPTY DATABASE, where this
-- statement CREATEs the function for the first time and it would otherwise
-- inherit the default EXECUTE TO PUBLIC. That is the whole finding of
-- 20260809180000, and the reason the convention is to write both lines every
-- time rather than to reason about which case you are in.
REVOKE ALL ON FUNCTION public.post_credit_entry(uuid, uuid, integer, text, uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_credit_entry(uuid, uuid, integer, text, uuid, uuid, text)
  TO authenticated, service_role;

DO $post$
DECLARE _src text; _code text;
BEGIN
  -- What this migration ESTABLISHES, provable from any starting state: the
  -- shipped body consults the permission matrix, not membership. Named
  -- explicitly rather than scanned, per CLAUDE.md -- and read from prosrc,
  -- which cannot raise for any prokind.
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_credit_entry';

  -- prosrc is the body INCLUDING its comments, and this assertion shipped
  -- broken because of it: the body above carries the line "Was is_org_member",
  -- written to explain the change, and `_src LIKE '%is_org_member%'` matched
  -- the explanation rather than a call. Production never saw it -- the applied
  -- statement had no such comment -- so the live database, `check-migrations`
  -- and `check-baseline-objects` were all green while the repo could not
  -- rebuild. The empty-database replay is the only thing that can see this,
  -- which is precisely the case CLAUDE.md makes for that job.
  --
  -- So test the CODE, not the text. Same move as the codeOnly() helper the TS
  -- tests use for exactly this class of false match. Stripping -- comments can
  -- also mangle a `--` inside a string literal in the body; that is fine here,
  -- because the result is only ever fed to the LIKE tests below.
  _code := regexp_replace(_src, '--[^\n]*', '', 'g');

  IF _src IS NULL THEN
    RAISE EXCEPTION 'post_credit_entry is missing after this migration';
  END IF;
  IF _code NOT LIKE '%manage_client_billing%' THEN
    RAISE EXCEPTION 'post_credit_entry does not check manage_client_billing';
  END IF;
  IF _code LIKE '%is_org_member%' THEN
    RAISE EXCEPTION 'post_credit_entry still gates on membership';
  END IF;

  IF has_function_privilege('anon',
       'public.post_credit_entry(uuid, uuid, integer, text, uuid, uuid, text)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION 'post_credit_entry is reachable by anon';
  END IF;

  RAISE NOTICE 'post_credit_entry now requires manage_client_billing.';
END $post$;
