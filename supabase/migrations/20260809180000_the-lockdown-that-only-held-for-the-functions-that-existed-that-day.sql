-- The publishable key could bill a customer, forge their texting consent, and
-- delete a chargeback. Verified live before and after.
--
-- This is 20260731190000 for the second time, and the reason it is happening
-- twice is the interesting part.
--
-- ── WHY THE JULY FIX DID NOT HOLD ──────────────────────────────────────────
--
-- That migration revoked EXECUTE from PUBLIC and anon in a loop over the live
-- catalog — deliberately not a list, because "a list would go stale the first
-- time anyone adds a function". The loop was right and it worked. What did not
-- work is the half that was supposed to keep it working:
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--
-- with the comment "stop new functions from arriving pre-granted. Without this
-- the next migration reopens the hole and nobody notices". That is exactly what
-- happened. Probed on this database, in a transaction that was rolled back:
--
--   pg_default_acl for postgres/public/functions:
--     postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres
--   a function created immediately afterwards:
--     =X/postgres | postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres
--
-- The `=X` is PUBLIC, and `anon` is a member of PUBLIC. Re-issuing the ALTER
-- DEFAULT PRIVILEGES inside the same transaction changed neither the stored row
-- nor the ACL of the next function created after it. The recorded default is
-- not suppressing the built-in EXECUTE-to-PUBLIC that Postgres puts on every
-- new function; it is sitting alongside it. So the July loop cleaned the 125
-- functions that existed that day and nothing more, and every function created
-- or re-signatured since has arrived executable by the key in the browser
-- bundle. A `CREATE OR REPLACE` inherits the old ACL and is safe; changing a
-- signature is a new function object and is not, which is how `skip_visit` came
-- back after 20260804110000 added `_skipped_at` to it.
--
-- Thirty-one SECURITY DEFINER functions are anon-executable today. Twenty-five
-- of them are that way purely through PUBLIC and were never granted to anon by
-- anybody. That matters for the fix: `REVOKE EXECUTE ... FROM anon` on those
-- twenty-five is a no-op, because the grant it removes does not exist. The
-- grant to remove is the one to PUBLIC.
--
-- ── WHAT WAS ACTUALLY REACHABLE, AND WHAT ONLY LOOKED IT ───────────────────
--
-- Reachable is not the same as exploitable and the difference had to be settled
-- one function at a time. Twenty-four of the thirty-one refused: every guard in
-- this schema is written `can_write_org(auth.uid(), _org)` — auth.uid(), never
-- a parameter — and with no JWT that resolves to `user_id = NULL`, which
-- matches no row. `seed_demo_org`, which wipes an organization, refused. The
-- three field-app writes refused. The six trigger functions are not even in
-- PostgREST's schema cache, and called directly they get "trigger functions can
-- only be called as triggers".
--
-- Four did not refuse, and the first one is the reason this file is not being
-- written next week.
--
-- `admin_generate_addon_charges_through(_org_id, _through)` has no permission
-- check, correctly — the `admin_` prefix in this schema means "carries the
-- logic with no check, for cron and service_role, where auth.uid() is NULL",
-- and the checked wrapper is `generate_addon_charges_through`. Its four
-- siblings — admin_generate_visits_through, admin_generate_seasonal_deepcleans,
-- admin_generate_invoice_for_client, admin_transition_missed_visits — are all
-- revoked from PUBLIC, anon and authenticated. This one is not, and the reason
-- is mundane: it was created on 20260807040000, after the July sweep, and no
-- sweep has run since. Probed as `anon` in a rolled-back transaction, against
-- one active add-on subscription:
--
--   admin_generate_addon_charges_through: NO AUTH ERROR, returned 2
--   addon_charges rows now: 2 | addon_debit ledger rows: 2
--   client credit 45000 -> 38000
--
-- Two invoiceable charges raised against a real customer and seventy dollars
-- taken out of their prepaid balance, by someone holding nothing but the
-- publishable key and an organization id — and the organization id is not a
-- secret, because `public_get_org_by_slug` returns it for any public slug, by
-- design, so a tenant's own lead form is enough to obtain one.
--
-- `file_reversal_review_item` has no check either, and it is not `admin_`
-- prefixed so nothing signals that. It writes the review-queue row that tells
-- an owner money has moved: as anon it inserted a $9,999.00 chargeback notice
-- into a real organization. Worse is its other half — with `_authoritative` and
-- a non-positive amount it DELETES the matching row, and a genuine
-- payment_chargeback item filed a moment earlier went 1 -> 0. That is the
-- notice about real money leaving a real account, removable by anyone.
--
-- `record_client_sms_consent` is the one with legal weight. Its guard reads
-- `IF _source <> 'portal' AND NOT can_write_org(...)`, so claiming to be the
-- portal skipped authorization entirely. As anon, against a client who had
-- opted OUT: sms_opt_out=f, consent_source=portal, consented=t. The database
-- now says that customer ticked a consent box on their own portal, with a
-- timestamp and the exact wording stored beside it, and the record of their
-- opt-out is gone. That record is the evidence a carrier is shown; forging it
-- is worse than deleting it.
--
-- `assert_available_on` raises `'% is off on % (back %)'` with the staff
-- member's display name in it. As anon: "Taylor Tech is off on 2026-08-09 (back
-- 2026-08-13)". Small, but it is a named person's absence read out of a
-- database by someone with no account. `is_staff_off`, `client_may_be_texted`
-- and `drive_minutes` are the same shape one notch quieter — a boolean or a
-- number about a staff member, a customer, or an organization's dispatch
-- settings, with no check of any kind.
--
-- ── WHY THE FIX IS SUBTRACTIVE AND IN THREE PARTS ──────────────────────────
--
-- The loop is the July shape again, because that reasoning was right: a list
-- goes stale, the catalog does not. It differs in two ways. It excludes
-- extension-owned functions, so pg_net — whose extension is registered in
-- `public` — is not touched. And it skips the allowlist by name rather than
-- revoking everything and granting six back, so there is no window inside the
-- transaction where the signup page is broken.
--
-- Checked before writing, and asserted below rather than trusted: every
-- function this loop touches carries an explicit `authenticated` grant and an
-- explicit `service_role` grant, so removing PUBLIC removes nothing a real
-- caller has; and no RLS policy anywhere calls any of them, which would have
-- made EXECUTE a requirement for the querying role rather than the function's.
--
-- Revoking from anon is not enough for the first two, though. `authenticated`
-- can reach them as well, and neither takes the caller's organization from
-- anything but a parameter — so any signed-in user of any tenant can bill, or
-- unfile a chargeback in, any other tenant. That is the same defect wearing a
-- JWT. Both go back to service_role only, which is where their only callers
-- already are: nightly.ts and stripe.ts, both on supabaseAdmin.
--
-- And `record_client_sms_consent` cannot be fixed by a grant at all, because
-- the bypass is in the body and `authenticated` legitimately needs the
-- function. The portal branch now additionally requires `auth.uid() IS NULL`.
-- The portal is not an anonymous caller: portal.functions.ts checks the session
-- token in `requirePortalSession` and then calls on the service-role client, so
-- it has no user identity and passes. A signed-in staff member claiming
-- `_source = 'portal'` now falls through to `can_write_org` like any other
-- source, which is the check they should always have had. This does mean
-- 'import' and 'reply' now require an org writer even from service_role;
-- nothing calls them today, and a server-side path that needs one should say so
-- deliberately rather than inherit it from a hole.
--
-- Deliberately NOT changed: `sms_consent_coverage` and `staff_time_off_impact`
-- end their WHERE clause with `is_org_member(auth.uid(), _org)`, so a stranger
-- gets `[{"with_phone":0,"consented":0,"opted_out":0}]` rather than a refusal.
-- Silent-empty reads as "this org has no customers with phone numbers", which
-- is a wrong answer rather than no answer. It is left alone anyway: after this
-- migration the only callers are org members, so the empty case is unreachable,
-- and rewriting a dashboard read to raise is a change to a working screen made
-- on a hunch. The six genuinely public functions are untouched — they hold
-- explicit anon grants, carry no PUBLIC grant, and are re-asserted below only
-- so the whole intended anonymous surface is legible in one place.

DO $pre$
DECLARE
  _anon_secdef int;
  _via_public int;
  _no_authenticated int;
  _policy_users int;
  _def text;
BEGIN
  SELECT count(*) INTO _anon_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF _anon_secdef <> 31 THEN
    RAISE WARNING 'expected 31 anon-executable SECURITY DEFINER functions in public, found %', _anon_secdef;
  END IF;

  -- The distinction the fix turns on: these are reachable through PUBLIC, not
  -- through a grant to anon. If that is no longer true the loop below is
  -- revoking something other than what this file describes.
  SELECT count(*) INTO _via_public
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl,'{}')) a WHERE a::text LIKE '=%');
  IF _via_public < 25 THEN
    RAISE WARNING 'expected at least 25 SECURITY DEFINER functions carrying a PUBLIC grant, found %', _via_public;
  END IF;

  -- Removing PUBLIC must not be the only way in for a signed-in caller.
  SELECT count(*) INTO _no_authenticated
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl,'{}')) a WHERE a::text LIKE 'authenticated=%');
  IF _no_authenticated <> 0 THEN
    RAISE EXCEPTION '% anon-executable functions have no explicit authenticated grant; revoking PUBLIC would lock out the app', _no_authenticated;
  END IF;

  -- A policy calling one of these would need the QUERYING role to hold EXECUTE,
  -- so revoking would break row access rather than an RPC.
  SELECT count(*) INTO _policy_users
    FROM pg_policy pol,
         (SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
             AND has_function_privilege('anon', p.oid, 'EXECUTE')
             AND p.proname NOT IN ('public_get_org_by_slug','public_get_org_for_lead_form',
                                   'public_quote','roadmap_vote_counts','cast_roadmap_vote',
                                   'org_accepts_public_leads')) t
   WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid),'') || ' ' ||
         coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),'') ~ ('\m' || t.proname || '\M');
  IF _policy_users <> 0 THEN
    RAISE EXCEPTION '% RLS policies call a function this migration revokes; revoking would break row access', _policy_users;
  END IF;

  -- The billing function really is unguarded, and its siblings really are
  -- locked, which is what makes this an oversight rather than a design.
  _def := pg_get_functiondef('public.admin_generate_addon_charges_through(uuid,date)'::regprocedure);
  IF _def ~* 'can_write_org|has_permission|has_role|is_org_member|is_platform_admin' THEN
    RAISE EXCEPTION 'admin_generate_addon_charges_through now carries a permission check; re-read before applying';
  END IF;
  IF has_function_privilege('anon', 'public.admin_generate_visits_through(uuid,date)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'admin_generate_visits_through is anon-executable too; the admin_ convention is not what this file assumes';
  END IF;

  -- The consent bypass, exactly as probed.
  _def := pg_get_functiondef('public.record_client_sms_consent(uuid,text,text)'::regprocedure);
  IF _def NOT LIKE '%_source <> ''portal'' AND NOT public.can_write_org%' THEN
    RAISE EXCEPTION 'record_client_sms_consent no longer has the portal bypass this migration closes';
  END IF;
  IF _def LIKE '%auth.uid() IS NULL%' THEN
    RAISE EXCEPTION 'record_client_sms_consent already distinguishes a server-side caller';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'file_reversal_review_item') THEN
    RAISE EXCEPTION 'file_reversal_review_item is gone';
  END IF;
END
$pre$;

-- ── 1. THE SWEEP ──────────────────────────────────────────────────────────
--
-- Over the catalog, not a list. Extension-owned functions are excluded so this
-- cannot reach into pg_net, and the six deliberate public entry points are
-- skipped rather than revoked-and-regranted so nothing is briefly unreachable.
DO $$
DECLARE _f record;
BEGIN
  FOR _f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f','p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
       AND p.proname NOT IN ('public_get_org_by_slug','public_get_org_for_lead_form',
                             'public_quote','roadmap_vote_counts','cast_roadmap_vote',
                             'org_accepts_public_leads')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', _f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', _f.sig);
  END LOOP;
END $$;

-- ── 2. THE TWO THAT ARE CROSS-TENANT FOR A SIGNED-IN CALLER TOO ───────────
--
-- Both take the organization from a parameter and check nothing against it, so
-- a grant to `authenticated` is a grant to every tenant over every other
-- tenant. Their only callers are server-side on the service-role client:
-- api/public/hooks/nightly.ts and api/public/hooks/stripe.ts. The app's own
-- route to add-on billing is the checked wrapper, generate_addon_charges_through.
REVOKE EXECUTE ON FUNCTION public.admin_generate_addon_charges_through(uuid, date)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid, text, bigint, boolean)
  FROM PUBLIC, anon, authenticated;

-- ── 3. THE BYPASS IN THE BODY ─────────────────────────────────────────────
--
-- Unchanged except for the guard. `_source = 'portal'` is now a statement about
-- the caller as well as about the record: only a caller with no user identity —
-- the service-role client, after portal.functions.ts has checked the session
-- token — may write consent without being an org writer.
CREATE OR REPLACE FUNCTION public.record_client_sms_consent(
  _client_id uuid, _text text, _source text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _org uuid; _phone text;
BEGIN
  SELECT organization_id, primary_phone INTO _org, _phone
    FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'No such client'; END IF;

  -- The portal has no user identity — it is the service-role client, called
  -- after the session token has been checked. Anything that DOES have one is a
  -- staff member and answers to can_write_org whatever source it claims.
  IF NOT (_source = 'portal' AND auth.uid() IS NULL)
     AND NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _source NOT IN ('portal', 'staff', 'import', 'reply') THEN
    RAISE EXCEPTION 'Unknown consent source: %', _source;
  END IF;
  IF _phone IS NULL THEN
    RAISE EXCEPTION 'Add a phone number before recording texting consent';
  END IF;
  IF _text IS NULL OR length(btrim(_text)) < 10 THEN
    RAISE EXCEPTION 'The consent wording must be stored with the consent';
  END IF;

  UPDATE public.clients
     SET sms_consent_at = now(),
         sms_consent_phone = _phone,
         sms_consent_text = _text,
         sms_consent_source = _source,
         sms_opt_out = false
   WHERE id = _client_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_client_sms_consent(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_client_sms_consent(uuid, text, text) TO authenticated, service_role;

-- ── 4. THE WHOLE INTENDED ANONYMOUS SURFACE, IN ONE PLACE ─────────────────
--
-- Idempotent re-assertion, not a widening: all six already hold these grants.
-- Written out so that the answer to "what can the publishable key call" is six
-- lines of SQL rather than a catalog query.
GRANT EXECUTE ON FUNCTION public.public_get_org_by_slug(text) TO anon;            -- signup.functions.ts, anon client
GRANT EXECUTE ON FUNCTION public.public_get_org_for_lead_form(text) TO anon;      -- api/public/leads.ts, unauthenticated
GRANT EXECUTE ON FUNCTION public.public_quote(text, text, integer, text) TO anon; -- signup.$slug.tsx, before an account exists
GRANT EXECUTE ON FUNCTION public.org_accepts_public_leads(uuid) TO anon;          -- the anon INSERT policy on leads calls it
GRANT EXECUTE ON FUNCTION public.roadmap_vote_counts() TO anon;                   -- marketing roadmap, from the browser
GRANT EXECUTE ON FUNCTION public.cast_roadmap_vote(text, text) TO anon;           -- marketing roadmap, from the browser

DO $post$
DECLARE
  _anon_exec text[];
  _expected text[] := ARRAY['cast_roadmap_vote','org_accepts_public_leads','public_get_org_by_slug',
                            'public_get_org_for_lead_form','public_quote','roadmap_vote_counts'];
  _def text;
BEGIN
  SELECT coalesce(array_agg(DISTINCT p.proname ORDER BY p.proname), '{}')
    INTO _anon_exec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF _anon_exec IS DISTINCT FROM _expected THEN
    RAISE EXCEPTION 'anon can still execute: %', array_to_string(_anon_exec, ', ');
  END IF;

  -- The two that were cross-tenant for a signed-in caller as well.
  IF has_function_privilege('authenticated', 'public.admin_generate_addon_charges_through(uuid,date)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.file_reversal_review_item(uuid,uuid,text,bigint,uuid,text,bigint,boolean)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'the two unguarded org-parameter functions are still executable by authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.admin_generate_addon_charges_through(uuid,date)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.file_reversal_review_item(uuid,uuid,text,bigint,uuid,text,bigint,boolean)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost the nightly job or the Stripe webhook';
  END IF;

  -- The app's own checked route to the same billing must survive.
  IF NOT has_function_privilege('authenticated', 'public.generate_addon_charges_through(uuid,date)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'the checked wrapper generate_addon_charges_through is no longer reachable by the app';
  END IF;

  _def := pg_get_functiondef('public.record_client_sms_consent(uuid,text,text)'::regprocedure);
  IF _def NOT LIKE '%_source = ''portal'' AND auth.uid() IS NULL%' THEN
    RAISE EXCEPTION 'the portal branch of record_client_sms_consent is not guarded on a null auth.uid()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.record_client_sms_consent(uuid,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'staff can no longer record consent on a client''s behalf';
  END IF;

  -- Signed-in callers keep everything else. Spot-checked on the field-app
  -- writes and the dispatch reads, which are the loudest failures if wrong.
  IF NOT has_function_privilege('authenticated', 'public.start_visit(uuid,timestamptz)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.drive_minutes(uuid,double precision,double precision,double precision,double precision)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.seed_demo_org(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'the sweep took EXECUTE away from authenticated';
  END IF;
END
$post$;
