-- Every row scanned re-parsed the JWT to ask who was asking. 140 policies, one
-- pair of parentheses each. Measured live before and after; nothing else moved.
--
-- ── WHAT THE ADVISOR IS ACTUALLY POINTING AT ──────────────────────────────
--
-- Supabase's performance advisor reports 294 issues on this project and the
-- largest single group is `auth_rls_initplan`, 140 of them. The name is opaque
-- and the finding is not: every one is an RLS policy whose USING or WITH CHECK
-- expression calls `auth.uid()` (or, in nine cases, `auth.role()`) in a
-- position where Postgres cannot hoist it.
--
-- `auth.uid()` is not a variable. It is a function, and this is its body:
--
--   COALESCE(
--     NULLIF(current_setting('request.jwt.claim.sub', true), ''),
--     (NULLIF(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'sub'
--   )::uuid
--
-- A GUC read, a jsonb cast, a jsonb key extraction and a uuid parse. It is
-- marked STABLE, which promises the answer will not change inside one
-- statement — but STABLE is a promise Postgres accepts and does not exploit.
-- It does not memoise stable functions. A stable function sitting in a scan
-- filter is called once per row the scan touches, and the whole of that body
-- runs each time.
--
-- Wrapping the call in a scalar subquery — `(select auth.uid())` — changes
-- that and only that. The subquery has no correlation to the outer row, so the
-- planner turns it into an InitPlan: evaluated once, before the scan starts,
-- and referenced afterwards as a constant. Same value, same type, same
-- nullability, same semantics. `auth.uid()` takes no arguments, so there is
-- nothing for the subquery to capture and nothing that could make its result
-- depend on the row it is being compared against.
--
-- ── THE PLAN, HERE, ON THIS DATABASE, MEASURED BOTH WAYS ──────────────────
--
-- The hottest table is `visits` — the route board, My Day, the calendar and
-- every dispatch query read it. 3,517 rows, 3,013 of them visible to a member
-- of the demo org. Measured as `authenticated` with a real member's claims, in
-- a single transaction that was rolled back, alternating the two policy shapes
-- three times so that cache state and the other agent's new indexes are held
-- constant and neither shape gets the warm-up advantage:
--
--   select count(*) from public.visits;
--
--     bare      130.201 ms   111.562 ms   117.775 ms
--     wrapped   103.411 ms   101.905 ms   104.049 ms
--
-- Around 118 ms down to around 103 ms. Twelve percent. That is the honest
-- number and it is not a headline, so it should not be dressed as one. The
-- month-calendar read — 439 rows through idx_visits_org_date — moves 13.4 ms
-- to 11.7 ms, and `Buffers: shared hit=808` is identical in both. No I/O
-- changed. This is pure CPU, which is exactly what it should be.
--
-- The plan is where the change is unmistakable. Before:
--
--   ->  Index Only Scan using idx_visits_org_date on visits
--         Filter: (is_org_member((COALESCE(NULLIF(current_setting(
--           'request.jwt.claim.sub'), ''), ((NULLIF(current_setting(
--           'request.jwt.claims'), ''))::jsonb ->> 'sub')))::uuid,
--           organization_id) OR can_write_org(<the same thing again>,
--           organization_id))
--         Rows Removed by Filter: 504
--
-- The entire body of auth.uid() is inlined into the filter, twice, and that
-- filter runs against every row the scan touches. After:
--
--   InitPlan 1
--     ->  Result (actual time=0.011..0.011 rows=1 loops=1)
--   InitPlan 2
--     ->  Result (actual time=0.003..0.004 rows=1 loops=1)
--   ->  Index Only Scan using idx_visits_org_date on visits
--         Filter: (is_org_member((InitPlan 1).col1, organization_id)
--                  OR can_write_org((InitPlan 2).col1, organization_id))
--
-- `rows=1 loops=1`. Once, before the scan. On the month-calendar plan InitPlan
-- 2 reads `(never executed)` outright, because the OR short-circuits on the
-- first branch and the second identity lookup never has to happen at all.
--
-- Why only twelve percent, when the JWT parse is gone entirely: because the
-- JWT parse was never most of the cost. What remains is `is_org_member` and
-- `can_write_org` themselves, and those still run once per row — they take
-- `organization_id` as an argument, so they genuinely are per-row questions.
-- Twelve percent is what removing the GUC read and the jsonb parse is worth
-- when two SECURITY DEFINER lookups per row stay behind. Anyone expecting a
-- multiple should expect it from a different change than this one.
--
-- It is still worth doing, for a reason the demo data cannot show: this cost
-- is linear in rows scanned, it is paid by every tenant on every read of every
-- one of 79 tables, and three demo organizations with 3,517 visits between
-- them is the smallest this product will ever be.
--
-- ── WHY THIS IS 140 ALTERs AND NOT ONE CLEVER LOOP ────────────────────────
--
-- The DDL below was generated from the live catalog, then written out
-- literally. A loop over pg_policy that rewrites whatever it finds would be
-- shorter and would be a worse record: read six months from now it says "some
-- policies were changed somehow", and the only way to know what the access
-- rules became is to go and look at a database that has since moved. These are
-- the access-control rules of a multi-tenant product. The file that changed
-- them should contain them.
--
-- `ALTER POLICY`, not `DROP` + `CREATE`. It is the narrower instrument: it
-- cannot change the command the policy applies to, cannot change PERMISSIVE to
-- RESTRICTIVE, cannot change the roles it is granted to, and cannot leave a
-- table briefly unprotected between the two halves of a swap. It only replaces
-- the expressions, which is the only thing this migration is entitled to do.
--
-- Nothing was tidied on the way past. Several of these predicates could be
-- shorter, a few tables have two policies that could be one, and the four
-- `email_send_log` / `suppressed_emails` policies that test
-- `auth.role() = 'service_role'` are arguably dead weight given service_role
-- carries BYPASSRLS. All of it is left exactly as it was. A semantic change
-- smuggled inside a performance change is invisible in review, and "while I
-- was in there" is how a tenant ends up reading another tenant's clients.
--
-- ── THE HELPER CASE, AND WHAT IT DOES NOT BUY ─────────────────────────────
--
-- Of the 230 call sites, only 39 are bare comparisons like
-- `user_id = auth.uid()`. The other 191 are the first argument to a SECURITY
-- DEFINER helper — has_permission (60), can_write_org (52), is_org_member
-- (33), is_platform_admin (32), has_role (14). Checked rather than assumed:
-- the advisor flags those too, because the lint matches an unwrapped `auth.*`
-- call anywhere in the expression, not a top-level one, and wrapping the
-- argument clears it.
--
-- It should be said honestly what that buys, because it is less than the
-- headline suggests. `is_org_member((select auth.uid()), organization_id)`
-- stops re-parsing the JWT per row. It does not stop `is_org_member` itself
-- running per row — it takes a column as its second argument, so it genuinely
-- is a per-row question and no amount of parenthesising changes that. What
-- goes away is the GUC read and the jsonb parse feeding it, and the
-- measurement above prices that at about twelve percent of the query, not at
-- most of it. The remaining cost is the helper lookups, and shifting those is
-- a different piece of work with a different risk profile.
--
-- `is_platform_admin((select auth.uid()))` is the one case where the whole
-- call could have been hoisted — no column arguments at all — by writing
-- `(select is_platform_admin(auth.uid()))`. It was not, for two reasons: it is
-- a different change from the one this file claims to make, and those 32 sites
-- are on platform-admin tables that a tenant never touches.
--
-- ── HOW EQUIVALENCE IS PROVEN RATHER THAN ASSERTED ────────────────────────
--
-- The $pre$ block snapshots every policy in `public` — name, table, command,
-- permissive flag, granted roles, and both expressions as Postgres deparses
-- them, whitespace collapsed. The $post$ block recomputes all of it and then
-- does the thing that matters: it takes each new expression, textually undoes
-- the wrapping (`( SELECT auth.uid() AS uid)` back to `auth.uid()`), and
-- requires the result to be byte-identical to what was there before. If a
-- predicate was reordered, a clause dropped, an operator flipped or a role
-- changed, the strings differ and the migration aborts. The only difference it
-- will tolerate is the parentheses it exists to add.
--
-- ── WHAT IS NOT TOUCHED ───────────────────────────────────────────────────
--
-- Ten of the 150 policies in `public` reference no auth call at all and are
-- not listed below. Two are worth naming so their absence is not read as an
-- oversight. `Read clients you may see` on `clients` is `may_read_client(id)`
-- — the auth call is inside the function body, where it is already evaluated
-- once per invocation and where the advisor correctly does not look.
-- `Anyone can submit a lead to a business that publishes a form` on `leads` is
-- the anonymous portal write; it identifies nobody and asks about nothing but
-- the row being inserted. Both are left alone.
--
-- No index is created or dropped here. Nothing outside pg_policy changes.

DO $pre$
DECLARE
  _total int;
  _unwrapped int;
  _wrapped int;
  _sites int;
BEGIN
  -- The whole starting state, kept for the $post$ block to compare against.
  -- Dropped explicitly at the end rather than ON COMMIT, because whether this
  -- file runs inside one transaction is the migration runner's business and
  -- not something to depend on.
  DROP TABLE IF EXISTS _policy_snapshot_before;
  CREATE TEMP TABLE _policy_snapshot_before AS
  SELECT c.relname                                        AS tbl,
         pol.polname                                      AS pol,
         pol.polcmd,
         pol.polpermissive,
         pol.polroles,
         regexp_replace(coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<none>'),
                        '\s+', ' ', 'g')                  AS qual,
         regexp_replace(coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<none>'),
                        '\s+', ' ', 'g')                  AS wchk
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public';

  SELECT count(*) INTO _total FROM _policy_snapshot_before;
  IF _total <> 150 THEN
    RAISE EXCEPTION 'expected 150 policies in public, found % — the schema has moved since this file was written', _total;
  END IF;

  -- The finding itself, counted from the catalog rather than taken from the
  -- advisor's word: policies carrying an auth call that is NOT already inside
  -- a scalar subquery.
  SELECT count(*) INTO _unwrapped
    FROM _policy_snapshot_before
   WHERE regexp_replace(qual || ' ' || wchk,
           '\(\s*SELECT\s+auth\.(uid|role)\(\)\s+AS\s+\w+\s*\)', '', 'g') ~ 'auth\.(uid|role)\(\)';
  IF _unwrapped <> 140 THEN
    RAISE EXCEPTION 'expected 140 policies with an unwrapped auth call, found %', _unwrapped;
  END IF;

  -- And none of them is partly done already, which would make the literal SQL
  -- below a rewrite of something other than what was measured.
  SELECT count(*) INTO _wrapped
    FROM _policy_snapshot_before
   WHERE (qual || ' ' || wchk) ~ '\(\s*SELECT\s+auth\.';
  IF _wrapped <> 0 THEN
    RAISE EXCEPTION '% policies already wrap an auth call; this file assumes none do', _wrapped;
  END IF;

  -- 230 call sites across those 140 policies. The count is asserted because
  -- the statements below are a transcription, and a transcription that misses
  -- one is a policy left slow with nothing to say so.
  SELECT sum((length(qual || ' ' || wchk) - length(replace(qual || ' ' || wchk, 'auth.', ''))) / 5)
    INTO _sites FROM _policy_snapshot_before;
  IF _sites <> 230 THEN
    RAISE EXCEPTION 'expected 230 auth call sites in public policies, found %', _sites;
  END IF;

  -- A textual rewrite is only safe if no auth call is inside a string literal.
  -- Strip every properly-paired literal and recount: the totals must match.
  SELECT count(*) INTO _wrapped
    FROM _policy_snapshot_before
   WHERE (length(qual || ' ' || wchk) - length(replace(qual || ' ' || wchk, 'auth.', '')))
      <> (length(regexp_replace(qual || ' ' || wchk, '''([^'']|'''''')*''', '@', 'g'))
          - length(replace(regexp_replace(qual || ' ' || wchk, '''([^'']|'''''')*''', '@', 'g'), 'auth.', '')));
  IF _wrapped <> 0 THEN
    RAISE EXCEPTION '% policies mention auth. inside a string literal; the rewrite below would corrupt them', _wrapped;
  END IF;
END
$pre$;

-- ── THE 140 ────────────────────────────────────────────────────────────────
--
-- In table then policy-name order, as the catalog reports them. Each is the
-- expression Postgres itself deparsed, with `auth.uid()` replaced by
-- `(select auth.uid())` and `auth.role()` by `(select auth.role())`, and
-- nothing else altered.

ALTER POLICY "accounting credentials: the office only" ON public.accounting_connections
  USING (has_permission((select auth.uid()), org_id, 'manage_settings'::text))
  WITH CHECK (has_permission((select auth.uid()), org_id, 'manage_settings'::text));

ALTER POLICY "Managers read sync log" ON public.accounting_sync_log
  USING (can_write_org((select auth.uid()), org_id));

ALTER POLICY "Managers write sync log" ON public.accounting_sync_log
  USING (can_write_org((select auth.uid()), org_id))
  WITH CHECK (can_write_org((select auth.uid()), org_id));

ALTER POLICY "Read activity log with the directory" ON public.activity_log
  USING (has_permission((select auth.uid()), organization_id, 'view_client_directory'::text));

ALTER POLICY activity_log_insert ON public.activity_log
  WITH CHECK ((is_org_member((select auth.uid()), organization_id) AND (actor_user_id = (select auth.uid()))));

ALTER POLICY "addon_charges readable by billing and finance roles" ON public.addon_charges
  USING ((has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text) OR has_permission((select auth.uid()), organization_id, 'view_financials'::text)));

ALTER POLICY "addon_charges writable by billing managers" ON public.addon_charges
  USING (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

ALTER POLICY "Managers update addon requests" ON public.addon_requests
  USING (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

ALTER POLICY addon_requests_select ON public.addon_requests
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "Managers write addon services" ON public.addon_services
  USING (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

ALTER POLICY "addon_services readable by org" ON public.addon_services
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "addon_subs readable by org" ON public.addon_subscriptions
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "addon_subs writable by billing managers" ON public.addon_subscriptions
  USING (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

ALTER POLICY "ai receptionist transcripts: the office only" ON public.ai_receptionist_logs
  USING (has_permission((select auth.uid()), organization_id, 'manage_settings'::text));

ALTER POLICY ai_usage_events_read ON public.ai_usage_events
  USING (has_permission((select auth.uid()), organization_id, 'manage_org_billing'::text));

ALTER POLICY ai_usage_periods_read ON public.ai_usage_periods
  USING (has_permission((select auth.uid()), organization_id, 'manage_org_billing'::text));

ALTER POLICY app_notification_prefs_select_own ON public.app_notification_prefs
  USING ((user_id = (select auth.uid())));

ALTER POLICY app_notification_prefs_upsert_own ON public.app_notification_prefs
  USING ((user_id = (select auth.uid())))
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY app_notifications_delete_own ON public.app_notifications
  USING ((recipient_user_id = (select auth.uid())));

ALTER POLICY app_notifications_select_own ON public.app_notifications
  USING ((recipient_user_id = (select auth.uid())));

ALTER POLICY app_notifications_update_own ON public.app_notifications
  USING ((recipient_user_id = (select auth.uid())))
  WITH CHECK ((recipient_user_id = (select auth.uid())));

ALTER POLICY "blackout read" ON public.blackout_dates
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "blackout write" ON public.blackout_dates
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY client_holds_select ON public.client_holds
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY client_holds_write ON public.client_holds
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY client_notes_delete ON public.client_notes
  USING ((is_org_member((select auth.uid()), organization_id) AND (has_role((select auth.uid()), organization_id, 'owner'::app_role) OR has_role((select auth.uid()), organization_id, 'office_manager'::app_role))));

ALTER POLICY client_notes_insert ON public.client_notes
  WITH CHECK ((is_org_member((select auth.uid()), organization_id) AND (created_by = (select auth.uid())) AND ((audience = 'technician'::text) OR has_role((select auth.uid()), organization_id, 'owner'::app_role) OR has_role((select auth.uid()), organization_id, 'office_manager'::app_role) OR has_role((select auth.uid()), organization_id, 'dispatcher'::app_role))));

ALTER POLICY client_notes_select ON public.client_notes
  USING ((is_org_member((select auth.uid()), organization_id) AND ((audience <> 'office'::text) OR has_role((select auth.uid()), organization_id, 'owner'::app_role) OR has_role((select auth.uid()), organization_id, 'office_manager'::app_role) OR has_role((select auth.uid()), organization_id, 'dispatcher'::app_role))));

ALTER POLICY client_notes_update ON public.client_notes
  USING ((is_org_member((select auth.uid()), organization_id) AND (has_role((select auth.uid()), organization_id, 'owner'::app_role) OR has_role((select auth.uid()), organization_id, 'office_manager'::app_role) OR has_role((select auth.uid()), organization_id, 'dispatcher'::app_role) OR ((audience = 'technician'::text) AND (created_by = (select auth.uid()))))));

ALTER POLICY "Managers write clients" ON public.clients
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "billing managers read ledger" ON public.credit_ledger
  USING (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

ALTER POLICY "billing managers write ledger" ON public.credit_ledger
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

ALTER POLICY "office deletes dna_matches" ON public.dna_matches
  USING (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "office inserts dna_matches" ON public.dna_matches
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "office reads dna_matches" ON public.dna_matches
  USING (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "office updates dna_matches" ON public.dna_matches
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Managers write dogs" ON public.dogs
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Service role can insert send log" ON public.email_send_log
  WITH CHECK (((select auth.role()) = 'service_role'::text));

ALTER POLICY "Service role can read send log" ON public.email_send_log
  USING (((select auth.role()) = 'service_role'::text));

ALTER POLICY "Service role can update send log" ON public.email_send_log
  USING (((select auth.role()) = 'service_role'::text))
  WITH CHECK (((select auth.role()) = 'service_role'::text));

ALTER POLICY "Service role can manage send state" ON public.email_send_state
  USING (((select auth.role()) = 'service_role'::text))
  WITH CHECK (((select auth.role()) = 'service_role'::text));

ALTER POLICY "Service role can insert tokens" ON public.email_unsubscribe_tokens
  WITH CHECK (((select auth.role()) = 'service_role'::text));

ALTER POLICY "Service role can mark tokens as used" ON public.email_unsubscribe_tokens
  USING (((select auth.role()) = 'service_role'::text))
  WITH CHECK (((select auth.role()) = 'service_role'::text));

ALTER POLICY "Service role can read tokens" ON public.email_unsubscribe_tokens
  USING (((select auth.role()) = 'service_role'::text));

ALTER POLICY "franchise adjustments: whoever may see financials" ON public.franchise_adjustments
  USING ((has_permission((select auth.uid()), parent_organization_id, 'view_financials'::text) OR has_permission((select auth.uid()), child_organization_id, 'view_financials'::text) OR is_platform_admin((select auth.uid()))));

ALTER POLICY "franchise link codes: only the franchise owner" ON public.franchise_link_codes
  USING (has_permission((select auth.uid()), parent_organization_id, 'manage_franchise'::text));

ALTER POLICY "franchise royalty: office reads" ON public.franchise_royalty_invoices
  USING (can_write_org((select auth.uid()), parent_organization_id));

ALTER POLICY "franchise royalty: only the franchise owner updates" ON public.franchise_royalty_invoices
  USING (has_permission((select auth.uid()), parent_organization_id, 'manage_franchise'::text))
  WITH CHECK (has_permission((select auth.uid()), parent_organization_id, 'manage_franchise'::text));

ALTER POLICY "gift card redemptions: the office only" ON public.gift_card_redemptions
  USING (has_permission((select auth.uid()), organization_id, 'manage_settings'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_settings'::text));

ALTER POLICY "gift cards: the office only" ON public.gift_cards
  USING (has_permission((select auth.uid()), organization_id, 'manage_settings'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_settings'::text));

ALTER POLICY "org read import_batches" ON public.import_batches
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "org write import_batches" ON public.import_batches
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "org read import_rows" ON public.import_rows
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "org write import_rows" ON public.import_rows
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Managers write inventory assignments" ON public.inventory_assignments
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Members read inventory assignments" ON public.inventory_assignments
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "Managers write inventory items" ON public.inventory_items
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Members read inventory items" ON public.inventory_items
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "Managers manage inventory movements" ON public.inventory_movements
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Members read inventory movements" ON public.inventory_movements
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "Members write inventory movements" ON public.inventory_movements
  WITH CHECK (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "line items readable via parent invoice" ON public.invoice_line_items
  USING ((EXISTS ( SELECT 1 FROM invoices i WHERE ((i.id = invoice_line_items.invoice_id) AND (has_permission((select auth.uid()), i.organization_id, 'manage_client_billing'::text) OR has_permission((select auth.uid()), i.organization_id, 'view_financials'::text))))));

ALTER POLICY "line items writable via parent invoice" ON public.invoice_line_items
  USING ((EXISTS ( SELECT 1 FROM invoices i WHERE ((i.id = invoice_line_items.invoice_id) AND has_permission((select auth.uid()), i.organization_id, 'manage_client_billing'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1 FROM invoices i WHERE ((i.id = invoice_line_items.invoice_id) AND has_permission((select auth.uid()), i.organization_id, 'manage_client_billing'::text)))));

ALTER POLICY "invoices readable by billing and finance roles" ON public.invoices
  USING ((has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text) OR has_permission((select auth.uid()), organization_id, 'view_financials'::text)));

ALTER POLICY "invoices writable by billing managers" ON public.invoices
  USING (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

ALTER POLICY "Managers can delete leads" ON public.leads
  USING ((EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = (select auth.uid())) AND (ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role])) AND (ur.organization_id = leads.organization_id)))));

ALTER POLICY "Managers can read leads" ON public.leads
  USING ((EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = (select auth.uid())) AND (ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role])) AND (ur.organization_id = leads.organization_id)))));

ALTER POLICY "Managers can update leads" ON public.leads
  USING ((EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = (select auth.uid())) AND (ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role])) AND (ur.organization_id = leads.organization_id)))))
  WITH CHECK ((EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = (select auth.uid())) AND (ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role])) AND (ur.organization_id = leads.organization_id)))));

ALTER POLICY "Managers write locations" ON public.locations
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Members read locations" ON public.locations
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "Read messages with the directory" ON public.messages
  USING (has_permission((select auth.uid()), organization_id, 'view_client_directory'::text));

ALTER POLICY "managers insert outbound" ON public.messages
  WITH CHECK ((can_write_org((select auth.uid()), organization_id) AND (direction = 'outbound'::message_direction)));

ALTER POLICY "managers update messages" ON public.messages
  USING (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "neighbor leads: whoever may see the client directory" ON public.neighbor_leads
  USING (has_permission((select auth.uid()), organization_id, 'view_client_directory'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'view_client_directory'::text));

ALTER POLICY org_invites_manage ON public.org_invites
  USING ((EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = (select auth.uid())) AND (ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role])) AND (ur.organization_id = org_invites.organization_id)))))
  WITH CHECK ((EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = (select auth.uid())) AND (ur.role = ANY (ARRAY['owner'::app_role, 'office_manager'::app_role])) AND (ur.organization_id = org_invites.organization_id)))));

ALTER POLICY "billing managers manage own platform addons" ON public.org_platform_addons
  USING (has_permission((select auth.uid()), organization_id, 'manage_org_billing'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_org_billing'::text));

ALTER POLICY "org members read own platform addons" ON public.org_platform_addons
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "platform admins manage org platform addons" ON public.org_platform_addons
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "Members read own org" ON public.organizations
  USING (is_org_member((select auth.uid()), id));

ALTER POLICY "Settings managers update own org" ON public.organizations
  USING (has_permission((select auth.uid()), id, 'manage_settings'::text))
  WITH CHECK (has_permission((select auth.uid()), id, 'manage_settings'::text));

ALTER POLICY "payments readable by billing and finance roles" ON public.payments
  USING ((has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text) OR has_permission((select auth.uid()), organization_id, 'view_financials'::text)));

ALTER POLICY "payments recorded by billing managers" ON public.payments
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

ALTER POLICY "platform admins manage platform addons" ON public.platform_addons
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "audit insert" ON public.platform_admin_audit
  WITH CHECK ((is_platform_admin((select auth.uid())) AND (actor_user_id = (select auth.uid()))));

ALTER POLICY "audit read" ON public.platform_admin_audit
  USING (is_platform_admin((select auth.uid())));

ALTER POLICY "platform admins can read admins" ON public.platform_admins
  USING (is_platform_admin((select auth.uid())));

ALTER POLICY "Platform admins read all reads" ON public.platform_announcement_reads
  USING (is_platform_admin((select auth.uid())));

ALTER POLICY "Users manage own reads" ON public.platform_announcement_reads
  USING ((user_id = (select auth.uid())))
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY "Platform admins manage announcements" ON public.platform_announcements
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "Platform admins manage coupons" ON public.platform_coupons
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "Platform admins manage flag catalog" ON public.platform_feature_flags
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "Platform admins manage invites" ON public.platform_invites
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "Platform admins manage SaaS invoices" ON public.platform_invoices
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "Members read own org flags" ON public.platform_org_feature_flags
  USING ((EXISTS ( SELECT 1 FROM user_roles ur WHERE ((ur.user_id = (select auth.uid())) AND (ur.organization_id = platform_org_feature_flags.organization_id)))));

ALTER POLICY "Platform admins manage org flags" ON public.platform_org_feature_flags
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "Platform admins manage plans" ON public.platform_plans
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "platform admins manage referral settings" ON public.platform_referral_settings
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "Platform admins manage signup requests" ON public.platform_signup_requests
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "Platform admins read Stripe events" ON public.platform_stripe_events
  USING (is_platform_admin((select auth.uid())));

ALTER POLICY "Platform admins manage support notes" ON public.platform_support_notes
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY "promo codes: the office only" ON public.promo_codes
  USING (has_permission((select auth.uid()), organization_id, 'manage_settings'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_settings'::text));

ALTER POLICY "Managers write properties" ON public.properties
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY property_units_select ON public.property_units
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY property_units_write ON public.property_units
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "user manages own push subs" ON public.push_subscriptions
  USING ((user_id = (select auth.uid())))
  WITH CHECK ((user_id = (select auth.uid())));

ALTER POLICY "qc read" ON public.qc_tickets
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "qc write" ON public.qc_tickets
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Read review items with the directory" ON public.review_items
  USING (has_permission((select auth.uid()), organization_id, 'view_client_directory'::text));

ALTER POLICY review_items_update ON public.review_items
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "signup requests: the office only" ON public.signup_requests
  USING (has_permission((select auth.uid()), organization_id, 'manage_settings'::text));

ALTER POLICY "skip rules: the office only" ON public.skip_billing_rules
  USING (has_permission((select auth.uid()), organization_id, 'manage_settings'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_settings'::text));

ALTER POLICY "Managers write staff" ON public.staff
  USING (has_permission((select auth.uid()), organization_id, 'manage_users'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_users'::text));

ALTER POLICY "Members read staff" ON public.staff
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY staff_time_off_read ON public.staff_time_off
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY staff_time_off_write ON public.staff_time_off
  USING (has_permission((select auth.uid()), organization_id, 'manage_users'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_users'::text));

ALTER POLICY "org read station logs" ON public.station_service_logs
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "org write station logs" ON public.station_service_logs
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Read subscriptions with the directory" ON public.subscriptions
  USING (has_permission((select auth.uid()), organization_id, 'view_client_directory'::text));

ALTER POLICY "subscriptions: priced by whoever sets pricing" ON public.subscriptions
  USING (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text));

ALTER POLICY "Service role can insert suppressed emails" ON public.suppressed_emails
  WITH CHECK (((select auth.role()) = 'service_role'::text));

ALTER POLICY "Service role can read suppressed emails" ON public.suppressed_emails
  USING (((select auth.role()) = 'service_role'::text));

ALTER POLICY "platform admins manage tenant referrals" ON public.tenant_referrals
  USING (is_platform_admin((select auth.uid())))
  WITH CHECK (is_platform_admin((select auth.uid())));

ALTER POLICY unit_incidents_select ON public.unit_incidents
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY unit_incidents_write ON public.unit_incidents
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Users read their own role rows" ON public.user_roles
  USING (((user_id = (select auth.uid())) OR has_role((select auth.uid()), organization_id, 'owner'::app_role)));

ALTER POLICY "assigned tech inserts visit photos" ON public.visit_photos
  WITH CHECK ((is_org_member((select auth.uid()), organization_id) AND (uploaded_by = (select auth.uid())) AND (EXISTS ( SELECT 1 FROM (visits v JOIN staff s ON ((s.id = v.assigned_staff_id))) WHERE ((v.id = visit_photos.visit_id) AND (v.organization_id = visit_photos.organization_id) AND (s.user_id = (select auth.uid())))))));

ALTER POLICY "managers delete visit photos" ON public.visit_photos
  USING (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "org members read visit photos" ON public.visit_photos
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "Managers write visits" ON public.visits
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Members read visits" ON public.visits
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "Techs update own visits" ON public.visits
  USING ((has_role((select auth.uid()), organization_id, 'tech'::app_role) AND (assigned_staff_id IN ( SELECT staff.id FROM staff WHERE (staff.user_id = (select auth.uid()))))))
  WITH CHECK ((has_role((select auth.uid()), organization_id, 'tech'::app_role) AND (assigned_staff_id IN ( SELECT staff.id FROM staff WHERE (staff.user_id = (select auth.uid()))))));

ALTER POLICY "org read facilities" ON public.waste_disposal_facilities
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "org write facilities" ON public.waste_disposal_facilities
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "org members log manifests" ON public.waste_disposal_manifests
  WITH CHECK (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "org read manifests" ON public.waste_disposal_manifests
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "org write manifests" ON public.waste_disposal_manifests
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "org read stations" ON public.waste_stations
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "org write stations" ON public.waste_stations
  USING (can_write_org((select auth.uid()), organization_id))
  WITH CHECK (can_write_org((select auth.uid()), organization_id));

ALTER POLICY "Members read zones" ON public.zones
  USING (is_org_member((select auth.uid()), organization_id));

ALTER POLICY "Pricing managers write zones" ON public.zones
  USING (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text));

DO $post$
DECLARE
  _n int;
  _bad text;
BEGIN
  DROP TABLE IF EXISTS _policy_snapshot_after;
  CREATE TEMP TABLE _policy_snapshot_after AS
  SELECT c.relname                                        AS tbl,
         pol.polname                                      AS pol,
         pol.polcmd,
         pol.polpermissive,
         pol.polroles,
         regexp_replace(coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<none>'),
                        '\s+', ' ', 'g')                  AS qual,
         regexp_replace(coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<none>'),
                        '\s+', ' ', 'g')                  AS wchk
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public';

  -- 1. NOTHING WAS LOST AND NOTHING APPEARED.
  SELECT count(*) INTO _n FROM _policy_snapshot_after;
  IF _n <> (SELECT count(*) FROM _policy_snapshot_before) THEN
    RAISE EXCEPTION 'policy count changed: % before, % after', (SELECT count(*) FROM _policy_snapshot_before), _n;
  END IF;

  -- Per table, not just in total: a policy dropped from one table and added to
  -- another keeps the total honest and the schema wrong.
  SELECT string_agg(format('%s: %s -> %s', tbl, coalesce(b, 0), coalesce(a, 0)), ', ')
    INTO _bad
    FROM (SELECT coalesce(x.tbl, y.tbl) AS tbl, x.n AS b, y.n AS a
            FROM (SELECT tbl, count(*) n FROM _policy_snapshot_before GROUP BY tbl) x
            FULL JOIN (SELECT tbl, count(*) n FROM _policy_snapshot_after GROUP BY tbl) y
              ON y.tbl = x.tbl
           WHERE coalesce(x.n, 0) <> coalesce(y.n, 0)) d;
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'policies per table changed: %', _bad;
  END IF;

  -- 2. NO POLICY CHANGED WHAT IT APPLIES TO.
  -- Command, permissive/restrictive and granted roles are not this file's to
  -- touch; ALTER POLICY cannot touch them, and this says so out loud.
  SELECT string_agg(format('%s.%s', tbl, pol), ', ')
    INTO _bad
    FROM (SELECT b.tbl, b.pol FROM _policy_snapshot_before b
            LEFT JOIN _policy_snapshot_after a ON a.tbl = b.tbl AND a.pol = b.pol
           WHERE a.pol IS NULL
              OR a.polcmd IS DISTINCT FROM b.polcmd
              OR a.polpermissive IS DISTINCT FROM b.polpermissive
              OR a.polroles IS DISTINCT FROM b.polroles) d;
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'command, permissiveness or granted roles changed on: %', _bad;
  END IF;

  -- 3. THE EQUIVALENCE PROOF.
  -- Undo the wrapping textually and require what is left to be exactly what
  -- was there before. Any reordering, any dropped clause, any flipped operator
  -- shows up here as a string that does not match.
  SELECT string_agg(format('%s.%s', tbl, pol), ', ')
    INTO _bad
    FROM (SELECT b.tbl, b.pol
            FROM _policy_snapshot_before b
            JOIN _policy_snapshot_after a ON a.tbl = b.tbl AND a.pol = b.pol
           WHERE regexp_replace(a.qual, '\(\s*SELECT\s+(auth\.(?:uid|role)\(\))\s+AS\s+\w+\s*\)', '\1', 'g') <> b.qual
              OR regexp_replace(a.wchk, '\(\s*SELECT\s+(auth\.(?:uid|role)\(\))\s+AS\s+\w+\s*\)', '\1', 'g') <> b.wchk) d;
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'expression changed by more than the subquery wrapper on: %', _bad;
  END IF;

  -- 4. THE FINDING IS GONE.
  SELECT count(*) INTO _n
    FROM _policy_snapshot_after
   WHERE regexp_replace(qual || ' ' || wchk,
           '\(\s*SELECT\s+auth\.(uid|role)\(\)\s+AS\s+\w+\s*\)', '', 'g') ~ 'auth\.(uid|role)\(\)';
  IF _n <> 0 THEN
    RAISE EXCEPTION '% policies still call an auth function outside a scalar subquery', _n;
  END IF;

  -- 5. AND IT IS GONE BY WRAPPING, NOT BY DELETION.
  -- All 230 call sites are still there, each now inside a subquery.
  SELECT sum((length(qual || ' ' || wchk) - length(replace(qual || ' ' || wchk, 'auth.', ''))) / 5)
    INTO _n FROM _policy_snapshot_after;
  IF _n <> 230 THEN
    RAISE EXCEPTION 'expected 230 auth call sites after the rewrite, found %', _n;
  END IF;

  DROP TABLE _policy_snapshot_before;
  DROP TABLE _policy_snapshot_after;
END
$post$;
