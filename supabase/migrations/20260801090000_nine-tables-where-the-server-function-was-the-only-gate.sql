-- Nine tables where the server function was the only gate.
--
-- A full RLS sweep of `public` — every table, every policy, and the helper each
-- one gates on. The recurring shape in this codebase, now found for the sixth
-- through fourteenth time: a server function authorizes correctly, and the
-- table underneath is open, so PostgREST is reachable directly with the anon
-- key and the user's own JWT. `authenticated` holds SELECT/INSERT/UPDATE/DELETE
-- on every table here; RLS is the only barrier there has ever been.
--
-- Proven live, in transactions that rolled themselves back:
--
--     TECH mint_$5000_giftcard=ALLOWED
--     DISPATCHER reads_quickbooks_token=TOKEN_SECRET
--     DISPATCHER repriced_subscriptions=24
--
-- In EVERY case below the correct predicate was already written down in the
-- TypeScript. The table simply did not enforce what the function claimed. Two
-- of the files say so in their own header comments:
--
--   promotions.functions.ts:8  "RLS alone only tenant-scopes the write — it
--                               does not check role — so gate every write on
--                               manage_settings."
--   accounting.functions.ts:10 "a dispatcher or tech must not be able to view,
--                               post, or trigger accounting connections."
--
-- Both were true statements about the server function and false statements
-- about the system. Each policy below is set to the permission its own writer
-- already requires, so the two can no longer disagree.
--
-- ── WHAT WAS REACHABLE ─────────────────────────────────────────────────────
--
--   gift_cards, gift_card_redemptions, promo_codes  (bare membership, FOR ALL)
--     A field TECH could mint a $5,000 gift card, top up an existing one, post
--     a redemption against an invoice, or delete cards customers had paid for;
--     and mint a 100%-off promo code for the whole customer base.
--     redeem_gift_card (SECURITY DEFINER) was bypassed entirely.
--
--   accounting_connections  (can_write_org, read AND write)
--     A DISPATCHER could read and overwrite the tenant's live QuickBooks/Xero
--     OAuth access and refresh tokens — full control of the company's books,
--     outside this application and outside its audit log. Refresh tokens
--     survive a password change, which makes this the highest-value item here.
--
--   subscriptions  (can_write_org)
--     A DISPATCHER could set a client's recurring price to $0.01; every future
--     generated invoice bills that. 24 live subscriptions in one org.
--     Every writer in subscriptions.functions.ts requires manage_pricing.
--
--   skip_billing_rules  (can_write_org)
--     A DISPATCHER could set billable_pct to 0 org-wide, so skipped visits are
--     never charged. skip-rules.functions.ts requires manage_settings.
--
--   ai_receptionist_logs, signup_requests  (bare membership, read)
--     Every field tech could read full AI-receptionist call and SMS
--     transcripts, and every inbound prospect's name, email, phone, address
--     and Stripe ids.
--
--   neighbor_leads  (bare membership, FOR ALL)
--     Prospect addresses and geo, writable by a tech.
--     neighbors.functions.ts requires view_client_directory.
--
--   push_subscriptions  (org-wide SELECT)
--     A tech could read the OWNER's endpoint, p256dh and auth secret. Sending
--     runs through supabaseAdmin and every app path filters on
--     `user_id = auth.uid()`, so nothing needs the org-wide read at all.
--     Exploiting it further needs the server's VAPID private key, so this is
--     credential disclosure, not a proven spoofing chain.
--
-- ── EXPOSURE ───────────────────────────────────────────────────────────────
--
-- Tenant isolation was never broken — every one of these is intra-org
-- privilege escalation, and a cross-org read was refused in every probe. Live
-- rows exist only for gift_cards (2), promo_codes (1) and subscriptions (24);
-- the rest are empty, so most of this is structural rather than exposed.
-- Nothing has been altered.
--
-- ── NOT CHANGED, DELIBERATELY ──────────────────────────────────────────────
--
-- client_holds keeps can_write_org. A hold pauses service, and a dispatcher
-- redistributing a sick tech's day legitimately places one — clients.functions
-- .ts gates it on view_client_directory, which dispatchers hold. The policy and
-- the function agree, so this is a product decision about whether a service
-- pause may also pause billing, not a defect to fix quietly here.

-- ── gift cards, redemptions, promo codes → manage_settings ─────────────────
DROP POLICY IF EXISTS "org members write gift cards" ON public.gift_cards;
DROP POLICY IF EXISTS "org members read gift cards" ON public.gift_cards;
CREATE POLICY "gift cards: the office only"
  ON public.gift_cards FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_settings'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_settings'));

DROP POLICY IF EXISTS "org members write gc redemptions" ON public.gift_card_redemptions;
DROP POLICY IF EXISTS "org members read gc redemptions" ON public.gift_card_redemptions;
CREATE POLICY "gift card redemptions: the office only"
  ON public.gift_card_redemptions FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_settings'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_settings'));

DROP POLICY IF EXISTS "org members write promo codes" ON public.promo_codes;
DROP POLICY IF EXISTS "org members read promo codes" ON public.promo_codes;
CREATE POLICY "promo codes: the office only"
  ON public.promo_codes FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_settings'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_settings'));

-- ── accounting credentials → manage_settings ──────────────────────────────
DROP POLICY IF EXISTS "Managers write connections" ON public.accounting_connections;
DROP POLICY IF EXISTS "Managers read connections" ON public.accounting_connections;
CREATE POLICY "accounting credentials: the office only"
  ON public.accounting_connections FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), org_id, 'manage_settings'))
  WITH CHECK (public.has_permission(auth.uid(), org_id, 'manage_settings'));

-- ── recurring price → manage_pricing ──────────────────────────────────────
DROP POLICY IF EXISTS "Managers write subscriptions" ON public.subscriptions;
CREATE POLICY "subscriptions: priced by whoever sets pricing"
  ON public.subscriptions FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_pricing'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_pricing'));
-- The read stays is_org_member: a tech has to see what service they are
-- performing. Reading a subscription is not the risk; repricing it is.

-- ── what a skip costs → manage_settings ───────────────────────────────────
DROP POLICY IF EXISTS "managers write skip rules" ON public.skip_billing_rules;
DROP POLICY IF EXISTS "org members read skip rules" ON public.skip_billing_rules;
CREATE POLICY "skip rules: the office only"
  ON public.skip_billing_rules FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_settings'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_settings'));
-- The read narrows too, and the verification block below is what caught that
-- it had a SECOND policy I had not noticed. `billable_pct` is a pricing figure
-- and its only screen is settings.skip-rules.tsx. Skipping a visit is
-- unaffected: skip_visit / office_skip_visit read this table from inside
-- SECURITY DEFINER routines, which do not consult these policies at all.

-- ── customer PII ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "org members read ai logs" ON public.ai_receptionist_logs;
CREATE POLICY "ai receptionist transcripts: the office only"
  ON public.ai_receptionist_logs FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_settings'));

DROP POLICY IF EXISTS "org members read signup_requests" ON public.signup_requests;
CREATE POLICY "signup requests: the office only"
  ON public.signup_requests FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_settings'));

DROP POLICY IF EXISTS "org staff write neighbor leads" ON public.neighbor_leads;
DROP POLICY IF EXISTS "org members read neighbor leads" ON public.neighbor_leads;
CREATE POLICY "neighbor leads: whoever may see the client directory"
  ON public.neighbor_leads FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'view_client_directory'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'view_client_directory'));

-- ── push credentials: your own row, and only your own ─────────────────────
DROP POLICY IF EXISTS "org staff view org push subs" ON public.push_subscriptions;
-- "user manages own push subs" (FOR ALL, user_id = auth.uid()) already covers
-- every path in push.functions.ts; delivery runs on supabaseAdmin.

DO $$
DECLARE _bad text;
BEGIN
  -- The defect in one query: a policy on one of these tables that still admits
  -- more than the permission its writer requires.
  SELECT string_agg(c.relname || '.' || p.polname, ', ') INTO _bad
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname IN ('gift_cards','gift_card_redemptions','promo_codes',
                       'accounting_connections','subscriptions','skip_billing_rules',
                       'ai_receptionist_logs','signup_requests','neighbor_leads')
     AND coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
         NOT LIKE '%has_permission%'
     -- the subscriptions READ policy is deliberately is_org_member
     AND NOT (c.relname = 'subscriptions' AND p.polcmd = 'r');
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'still gated on membership rather than a permission: %', _bad;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
              WHERE c.relname = 'push_subscriptions' AND p.polname = 'org staff view org push subs') THEN
    RAISE EXCEPTION 'the org-wide push credential read is still there';
  END IF;

  -- Every table touched here must still have RLS ON. Narrowing a policy while
  -- RLS is off would read as a fix and change nothing.
  SELECT string_agg(relname, ', ') INTO _bad FROM pg_class
   WHERE relname IN ('gift_cards','gift_card_redemptions','promo_codes',
                     'accounting_connections','subscriptions','skip_billing_rules',
                     'ai_receptionist_logs','signup_requests','neighbor_leads',
                     'push_subscriptions')
     AND relkind = 'r' AND NOT relrowsecurity;
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS is OFF on: %', _bad;
  END IF;
END $$;
