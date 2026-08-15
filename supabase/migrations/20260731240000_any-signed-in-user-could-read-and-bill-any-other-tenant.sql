-- Signup is public, so "signed in" is not an authorization decision — it is a
-- form anyone can fill in. 20260731190000 took the schema away from `anon` and
-- deliberately did not touch `authenticated`, which left every one of these
-- SECURITY DEFINER functions reachable by any account on the platform, for any
-- organization id, with RLS bypassed because SECURITY DEFINER is the point.
--
-- ── WHAT WAS ACTUALLY REACHABLE ────────────────────────────────────────────
--
-- Executed live on 2026-07-31 as `SET ROLE authenticated` with
-- request.jwt.claims naming a real user of "Demo Pet Waste Co", against the
-- real organization id of "Detroit Doo Disposal" (a different tenant, 243
-- customers), inside a transaction that was rolled back:
--
--   is_org_member(uid, victim_org)  → false        (not a member, confirmed)
--   SELECT … FROM clients WHERE …   → 0 rows       (RLS works; direct read denied)
--
--   client_ltv(victim, 5)           → 5 rows, real customer names and revenue
--   client_cohort_retention(victim) → 13 rows
--   zone_profitability(victim, …)   → 1 row
--   churn_drivers(victim)           → executed
--   org_can_add_client(victim)      → true
--   plan_tier_for_org(victim)       → 'launch'
--   org_seat_overage_cents(victim)  → 0
--   post_credit_entry(victim, …)    → a customer of the other tenant went from
--                                     0 to 50000 cents of account credit, with
--                                     a matching credit_ledger row. Money.
--   enqueue_email(…)                → accepted into the outbound mail queue
--
-- That is the whole shape of it: RLS denies the table and the function hands
-- the same data over, because the function trusts an org id it was handed.
--
-- ── TWO FIXES, AND WHY THE CHOICE PER FUNCTION IS NOT COSMETIC ─────────────
--
-- A function the app calls on the CALLER'S OWN client (`context.supabase`,
-- which carries the user's JWT against the publishable key) must keep its
-- `authenticated` grant or the product breaks; it needs a check inside. A
-- function only ever called by `supabaseAdmin` — or by another SECURITY
-- DEFINER function, or by a trigger, all of which run as the owner `postgres`
-- and are unaffected by grants — does not need the grant at all, and taking it
-- away is both cheaper and stronger than any check.
--
-- Every decision below was made by grepping src/ for `.rpc("<name>"` and
-- resolving which client the call site holds, then checking pg_proc.prosrc,
-- pg_trigger, pg_policy and cron.job for callers that never appear in
-- TypeScript. Where the evidence was not unambiguous, the function got a check
-- rather than a revoke: a wrong revoke breaks a working product, a redundant
-- check does not.
--
-- ── CHECKED (grant kept, membership enforced inside) ───────────────────────
--
--   client_ltv, client_cohort_retention, zone_profitability, churn_drivers
--       src/lib/analytics.functions.ts — all four on context.supabase.
--   post_credit_entry
--       src/lib/invoices.functions.ts:1106 (addClientCredit) on
--       context.supabase, behind requirePermission(manage_client_billing).
--   org_can_add_client
--       src/lib/imports.functions.ts:757 (commitImport) on context.supabase.
--
-- The check is MEMBERSHIP — is_org_member(auth.uid(), _org_id) — not a
-- permission, on purpose. The hole is cross-tenant reach; which roles inside a
-- tenant may see revenue or issue credit is a different question, already
-- answered by requirePermission in the TypeScript layer, and duplicating it
-- here in a weaker form would lock out legitimate roles without closing
-- anything. post_credit_entry gets one extra clause because org membership
-- alone does not stop a member of tenant A passing their own org id with
-- tenant B's client id: the client must belong to the org being charged.
--
-- ── EXEMPTED FROM THE CHECK: auth.uid() IS NULL ───────────────────────────
--
-- All six guards run only when there is a caller identity to enforce against,
-- following tg_orgs_protect_platform_columns, which exempts `service_role` for
-- the same reason. auth.uid() is NULL for the service-role client and for
-- pg_cron, and those callers reach these functions constantly:
--
--   post_credit_entry   ← tg_invoice_paid_credit (trigger on invoices, fires
--                         when the Stripe webhook marks an invoice paid on
--                         supabaseAdmin), and apply_credit_to_invoice,
--                         apply_referral_code, redeem_gift_card,
--                         finalize_visit_completion.
--   org_can_add_client  ← tg_clients_enforce_plan_limit (trigger on clients),
--                         which fires on the nightly service-role imports.
--
-- This is not a hole. A NULL auth.uid() means the request never carried a user
-- JWT, which on this deployment means it came from server code holding the
-- service-role key — code that has already decided which organization it
-- means, and which could in any case read the tables directly. The exemption
-- adds no reach that the service-role key does not already have. It is
-- deliberately keyed on the ABSENCE of an identity, not on a claim the caller
-- supplies, so nothing a signed-in user can put in their JWT reaches it.
--
-- When a caller identity IS present the guard applies even through those
-- internal paths, and that is correct: a staff user marking their own org's
-- invoice paid is a member of that org, and bootstrap_organization inserts
-- user_roles before anything that can fire the plan-limit trigger.
--
-- The four analytics functions change LANGUAGE from `sql` to `plpgsql`. A
-- LANGUAGE sql function cannot RAISE, and returning an empty set instead reads
-- as "no data" rather than "denied". `#variable_conflict use_column` is
-- required by that conversion: these all `ORDER BY` / `GROUP BY` a name that
-- is also an OUT parameter (revenue_cents, reason, cohort_month), which is
-- ambiguous inside plpgsql and would otherwise fail to parse. The queries
-- themselves are byte-identical to what pg_get_functiondef returned; verified
-- afterwards by md5 of the full result set for two real organizations.
--
-- ── REVOKED (no caller needs the grant) ───────────────────────────────────
--
-- Money and tenant writes, all called only with supabaseAdmin or by an owner-
-- run SQL caller:
--   record_franchise_adjustment      src/routes/api/public/hooks/stripe.ts:512
--   file_reversal_review_item        src/routes/api/public/hooks/stripe.ts:525
--   admin_generate_seasonal_deepcleans  hooks/nightly.ts:205
--   assign_billing_tier_for_org      lib/platform-billing.functions.ts:241,
--                                    plus reassign_all_billing_tiers,
--                                    tg_orgs_sync_tier_on_plan,
--                                    trg_reassign_billing_tier
--   reassign_all_billing_tiers       lib/platform-billing.functions.ts:222
--   refresh_active_client_count      only tg_clients_maintain_count
--   refresh_active_seat_count        only tg_staff_maintain_seat_count
--   finalize_visit_completion        only complete_visit, confirm_open_visit,
--                                    office_complete_visit — no TS caller
--   record_visit_station_service     only finalize_visit_completion
--
-- The email queue, whose entire surface was reachable — enqueue a message,
-- read other tenants' queued payloads, delete them, or fire the dispatcher:
--   enqueue_email, read_email_batch, delete_email, move_to_dlq
--       lib/email/enqueue.server.ts, lib/digest.server.ts,
--       lib/auth-entry.functions.ts, routes/email/** — every one of them on a
--       service-role client.
--   email_queue_dispatch
--       only email_queue_wake (trigger) and the 'process-email-queue' cron
--       job. It reads a service-role key out of the vault and POSTs it.
--
-- Plan/billing lookups with no caller that holds a user JWT:
--   plan_tier_for_org                only has_plan_entitlement
--   has_plan_entitlement             nothing calls it at all (the SQL mirror
--                                    of PLAN_ENTITLEMENTS; see
--                                    scripts/dead-machinery-baseline.json)
--   client_default_billing_cadence   only create_addon_charge,
--                                    generate_addon_charges_through,
--                                    generate_invoices_for_org,
--                                    run_billing_cycles
--   org_seat_overage_cents           no caller anywhere, in SQL or TypeScript
--
-- The customer portal RPCs. These were NOT on the brief and are the largest
-- single item here, so the evidence is spelled out. Every one takes a portal
-- token and is SECURITY DEFINER; portal_get_client alone returns a customer's
-- name, phone, email, balance, saved card brand and last4. All 21 are called
-- from exactly one file, src/lib/portal.functions.ts, and every call goes
-- through its local `admin()` helper, which returns supabaseAdmin, after
-- portal-auth has checked the OTP session. 20260731190000 established the same
-- thing when it declined to give them back to `anon`; the consequence it did
-- not draw is that `authenticated` never needed them either. Because anon is
-- already revoked, no browser can reach them today by any path, so this cannot
-- break a client-side caller — there is none to break.
--
-- ── DELIBERATELY NOT TOUCHED ──────────────────────────────────────────────
--
--   cast_roadmap_vote, roadmap_vote_counts, public_get_org_by_slug,
--   public_get_org_for_lead_form, public_quote — the five kept for anon by
--   20260731190000, intentionally public.
--   is_org_member, has_role, has_permission, can_write_org, is_platform_admin,
--   is_visit_tech — the authorization primitives themselves. RLS policy
--   expressions are evaluated as the querying user, so `authenticated` must
--   keep EXECUTE or every policy that calls them starts failing. They return a
--   boolean about a (user, org) pair and read no tenant data.
--   Trigger functions (tg_*, trg_*, apply_inventory_movement,
--   recalc_visit_station_count) — Postgres refuses to call a trigger function
--   directly and PostgREST does not expose them, so the grant is inert.
--
-- Idempotent: CREATE OR REPLACE and REVOKE are both re-runnable, and re-running
-- is the point if a future blanket GRANT undoes it.

-- ── CHECKED ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.client_ltv(_org_id uuid, _limit integer DEFAULT 25)
 RETURNS TABLE(client_id uuid, display_name text, tenure_days integer, revenue_cents bigint, monthly_avg_cents bigint, active boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_org_member(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT c.id, c.display_name,
    GREATEST(1, EXTRACT(DAY FROM (now() - c.created_at))::int) AS tenure_days,
    COALESCE(SUM(i.total_cents) FILTER (WHERE i.status = 'paid'), 0)::bigint AS revenue_cents,
    CASE
      WHEN GREATEST(1, EXTRACT(DAY FROM (now() - c.created_at))::int) = 0 THEN 0
      ELSE (COALESCE(SUM(i.total_cents) FILTER (WHERE i.status = 'paid'), 0)::bigint * 30
            / GREATEST(1, EXTRACT(DAY FROM (now() - c.created_at))::int))
    END::bigint AS monthly_avg_cents,
    c.active
  FROM public.clients c
  LEFT JOIN public.invoices i ON i.client_id = c.id
  WHERE c.organization_id = _org_id
  GROUP BY c.id
  ORDER BY revenue_cents DESC
  LIMIT _limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.churn_drivers(_org_id uuid)
 RETURNS TABLE(reason text, client_count integer, avg_score numeric, revenue_at_risk_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_org_member(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH scored AS (
    SELECT c.id, COALESCE(NULLIF(TRIM(c.churn_reason), ''), 'Unclassified') AS reason,
           c.churn_score,
           COALESCE((SELECT SUM(i.total_cents) FROM public.invoices i
                     WHERE i.client_id = c.id AND i.status = 'paid'
                       AND i.paid_at >= now() - interval '180 days'), 0) AS recent_rev
    FROM public.clients c
    WHERE c.organization_id = _org_id AND c.churn_score IS NOT NULL
  )
  SELECT reason,
         COUNT(*)::int AS client_count,
         ROUND(AVG(churn_score)::numeric, 2) AS avg_score,
         SUM(recent_rev)::bigint AS revenue_at_risk_cents
  FROM scored
  GROUP BY reason
  ORDER BY revenue_at_risk_cents DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.client_cohort_retention(_org_id uuid, _months_back integer DEFAULT 12)
 RETURNS TABLE(cohort_month date, months_since integer, cohort_size integer, retained integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_org_member(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH cohorts AS (
    SELECT id AS client_id, date_trunc('month', created_at)::date AS cohort_month
    FROM public.clients
    WHERE organization_id = _org_id
      AND created_at >= (now() - make_interval(months => _months_back))
  ),
  activity AS (
    SELECT c.client_id, c.cohort_month,
      GREATEST(0, (EXTRACT(YEAR FROM AGE(date_trunc('month', v.completed_at), c.cohort_month)) * 12
        + EXTRACT(MONTH FROM AGE(date_trunc('month', v.completed_at), c.cohort_month)))::int) AS months_since
    FROM cohorts c
    LEFT JOIN public.visits v
      ON v.client_id = c.client_id
     AND v.status = 'completed'
     AND v.completed_at IS NOT NULL
  ),
  sizes AS (
    SELECT cohort_month, COUNT(*)::int AS cohort_size FROM cohorts GROUP BY cohort_month
  )
  SELECT s.cohort_month, m.months_since,
         s.cohort_size,
         COUNT(DISTINCT a.client_id) FILTER (WHERE a.months_since = m.months_since)::int AS retained
  FROM sizes s
  CROSS JOIN generate_series(0, _months_back) AS m(months_since)
  LEFT JOIN activity a ON a.cohort_month = s.cohort_month
  GROUP BY s.cohort_month, s.cohort_size, m.months_since
  ORDER BY s.cohort_month DESC, m.months_since ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.zone_profitability(_org_id uuid, _from date, _to date)
 RETURNS TABLE(zone_id uuid, zone_name text, visit_count integer, completed_count integer, revenue_cents bigint, avg_revenue_per_visit_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_org_member(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT z.id, z.name,
    COUNT(v.id)::int AS visit_count,
    COUNT(v.id) FILTER (WHERE v.status = 'completed')::int AS completed_count,
    COALESCE(SUM(s.price_cents) FILTER (WHERE v.status = 'completed'), 0)::bigint AS revenue_cents,
    CASE WHEN COUNT(v.id) FILTER (WHERE v.status = 'completed') = 0 THEN 0
         ELSE (COALESCE(SUM(s.price_cents) FILTER (WHERE v.status = 'completed'), 0)::bigint
               / COUNT(v.id) FILTER (WHERE v.status = 'completed'))
    END::bigint AS avg_revenue_per_visit_cents
  FROM public.zones z
  LEFT JOIN public.visits v
    ON v.zone_id = z.id
   AND v.scheduled_on BETWEEN _from AND _to
  LEFT JOIN public.subscriptions s ON s.id = v.subscription_id
  WHERE z.organization_id = _org_id
  GROUP BY z.id, z.name
  ORDER BY revenue_cents DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.org_can_add_client(_org_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_org_member(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN (
    SELECT CASE
      WHEN o.plan_status IN ('active', 'past_due') THEN true
      WHEN o.plan_status = 'trialing' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > now()) THEN true
      WHEN o.plan_status = 'free' THEN true
      -- Admin-granted grace window: lets a canceled/lapsed tenant keep working
      -- long enough to reach their own Billing settings and reactivate.
      WHEN o.grace_expires_at IS NOT NULL AND o.grace_expires_at > now() THEN true
      ELSE false
    END
    FROM public.organizations o WHERE o.id = _org_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_credit_entry(_org_id uuid, _client_id uuid, _delta integer, _kind text, _invoice_id uuid, _visit_id uuid, _note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT public.is_org_member(auth.uid(), _org_id) THEN
      RAISE EXCEPTION 'Not authorized for this organization.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Membership alone still lets a member of one tenant name their own org id
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
  UPDATE public.clients SET credit_balance_cents = credit_balance_cents + _delta, updated_at = now()
   WHERE id = _client_id;
END; $function$;

-- ── REVOKED ───────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.record_franchise_adjustment(uuid, text, bigint, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_generate_seasonal_deepcleans(uuid, integer, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_billing_tier_for_org(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.reassign_all_billing_tiers() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_active_client_count(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_active_seat_count(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_visit_completion(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.record_visit_station_service(uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.enqueue_email(text, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.read_email_batch(text, integer, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_email(text, bigint) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.move_to_dlq(text, text, bigint, jsonb) FROM authenticated;

-- `email_queue_dispatch` is revoked ONLY IF IT EXISTS, and the story is worth
-- keeping because this one line has now caused two separate problems.
--
-- The function was never created by any migration. It arrived with the Lovable
-- email scaffold, directly in the live database, and 20260801092000 later
-- DROPPED it — a SECURITY DEFINER routine that POSTed a vaulted service_role
-- key to a lovable.app host.
--
-- (1) It hid from the drift sweep, because that sweep counted this very REVOKE
--     as a definition. 20260801092000 says so itself: "One bug in a checker
--     concealed one bug in the schema, which is the whole argument for
--     mutation-testing the checkers."
--
-- (2) It then broke the replay from empty, which is the third fault the
--     Sandboxes workflow found:
--
--         ERROR: function public.email_queue_dispatch() does not exist
--         At statement: 19
--         REVOKE EXECUTE ON FUNCTION public.email_queue_dispatch() FROM authenticated
--
--     Against production the REVOKE succeeded, because there the function was
--     real. From nothing there is nothing to revoke on, and — since it is
--     dropped a day later anyway — nothing this statement could usefully do.
--
-- Guarded rather than deleted, for the same reason as the roadmap grants in
-- 20260731190000: a database that stops between this migration and the DROP
-- should still have the privilege removed.
DO $$
BEGIN
  IF to_regprocedure('public.email_queue_dispatch()') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.email_queue_dispatch() FROM authenticated';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.plan_tier_for_org(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.has_plan_entitlement(uuid, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.client_default_billing_cadence(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.org_seat_overage_cents(uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.portal_get_client(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_get_referral(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_list_addon_catalog(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_list_client_addons(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_list_dogs(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_list_invoices(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_list_my_requests(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_list_prepaid_subscriptions(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_list_recent_visits(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_list_stations(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_list_upcoming_visits(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_cancel_addon(uuid, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_change_frequency(uuid, uuid, service_frequency) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_redeem_promo(uuid, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_report_concern(uuid, uuid, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_request_skip(uuid, uuid, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_request_vacation_hold(uuid, date, date, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_reschedule_visit(uuid, uuid, date) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_set_autopay(uuid, boolean) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_start_prepaid_topup(uuid, uuid, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.portal_subscribe_addon(uuid, uuid, addon_frequency, integer, uuid) FROM authenticated;

-- CREATE OR REPLACE above re-emits each function with the grants it already
-- had, which for the six checked ones is exactly what we want: they keep
-- `authenticated` and are now safe with it. Re-assert service_role explicitly
-- so a future owner change cannot leave the nightly and webhook paths without
-- it.
GRANT EXECUTE ON FUNCTION public.client_ltv(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.churn_drivers(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.client_cohort_retention(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.zone_profitability(uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.org_can_add_client(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_credit_entry(uuid, uuid, integer, text, uuid, uuid, text) TO authenticated, service_role;
