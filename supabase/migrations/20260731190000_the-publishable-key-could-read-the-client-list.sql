-- The anonymous key could read tenant business data and write to the email
-- queue. Verified live before and after.
--
-- ── WHAT WAS ACTUALLY WRONG ────────────────────────────────────────────────
--
-- 125 of the 159 functions in `public` carried a grant to PUBLIC, and every one
-- of those was therefore executable by `anon` — the publishable key that ships
-- inside the browser bundle of every page we serve. 112 of them are SECURITY
-- DEFINER, so they run as the owner and RLS does not apply to what they touch.
-- 73 of those contain no authorization check of any kind, because they were
-- written on the assumption that only a signed-in caller could reach them.
--
-- Individual migrations DID revoke: 20260702001425 ends with
-- `REVOKE ALL ON FUNCTION optimize_route_for_day FROM public`. It did not hold.
-- Something later re-granted the schema wholesale — the usual
-- `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated`
-- shape — which silently undid every hand-written REVOKE that came before it
-- and every one that came after was equally temporary. That is why this
-- migration revokes in a loop over the live catalog rather than naming
-- functions: a list would go stale the first time anyone adds a function.
--
-- ── WHAT WAS ACTUALLY REACHABLE ────────────────────────────────────────────
--
-- Confirmed by executing as `anon` with NO JWT at all, against live data:
--
--   client_ltv(org, 5)      → 5 real customer names with revenue and tenure
--   churn_drivers(org)      → 6 rows of churn analysis
--   enqueue_email(q, jsonb) → accepted a message into the email queue
--
-- The org UUID those need is not a secret: public_get_org_by_slug and
-- public_get_org_for_lead_form return it for any public slug, by design, so the
-- lead form on a tenant's own website is enough to obtain one. Also reachable
-- were admin_generate_invoices_for_org and admin_generate_seasonal_deepcleans
-- (which WRITE invoices and visits into any organization by id),
-- post_credit_entry (which writes account credit — money), and the rest of the
-- email queue (read_email_batch returns payloads, delete_email removes them).
--
-- This is BUG-28's shape a second time. There, the anon key authorized three
-- cron endpoints; the fix was to stop trusting that key at those endpoints.
-- What was not done then, and is done here, is asking what ELSE that key could
-- reach.
--
-- ── THE FIX, AND WHY IT IS A DENY-LIST INVERSION ───────────────────────────
--
-- Revoke EXECUTE from PUBLIC and anon on every function in the schema, then
-- grant back the five that genuinely serve anonymous callers. Verified before
-- writing this that the inversion is safe:
--
--   - Every function carrying a PUBLIC grant ALSO carries an explicit
--     `authenticated` grant (checked: zero exceptions), so signed-in callers
--     lose nothing.
--   - Every function has an explicit `service_role` grant (checked: zero
--     exceptions), so the server-side paths lose nothing.
--   - The eight functions with no `authenticated` grant are already
--     service_role-only and have no PUBLIC grant, so they are untouched.
--
-- The five kept for anon, each with the caller that needs it:
--
--   public_get_org_by_slug       signup.functions.ts, anon client
--   public_quote                 signup.functions.ts, anon client
--   public_get_org_for_lead_form leads.functions.ts + api/public/leads.ts
--   roadmap_vote_counts          marketing site roadmap.astro, from the browser
--   cast_roadmap_vote            marketing site roadmap.astro, from the browser
--
-- The portal RPCs are deliberately NOT in that list. They take a token and look
-- anonymous, but every one is called through portal.functions.ts on the
-- service-role client after a session check — so they never needed the grant,
-- and holding it meant anyone with the publishable key and a client UUID could
-- have called portal_get_client directly, session check and all, from outside.
--
-- Default privileges are reset too, so the next function added does not arrive
-- with a PUBLIC grant and quietly reopen this.
--
-- Idempotent: safe to re-run, and re-running is the point — if a future
-- blanket GRANT undoes it again, applying this fixes it.

DO $$
DECLARE _f record;
BEGIN
  FOR _f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', _f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', _f.sig);
  END LOOP;
END $$;

-- Stop new functions from arriving pre-granted. Without this the next
-- migration reopens the hole and nobody notices, which is exactly the history
-- this file is correcting.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

-- The five that genuinely serve an anonymous caller. Each is SECURITY DEFINER
-- and each is scoped by something the caller must already know — a public slug,
-- or nothing at all in the case of the roadmap counts.
GRANT EXECUTE ON FUNCTION public.public_get_org_by_slug(text) TO anon;
GRANT EXECUTE ON FUNCTION public.public_get_org_for_lead_form(text) TO anon;
GRANT EXECUTE ON FUNCTION public.public_quote(text, text, integer, text) TO anon;
GRANT EXECUTE ON FUNCTION public.roadmap_vote_counts() TO anon;
GRANT EXECUTE ON FUNCTION public.cast_roadmap_vote(text, text) TO anon;
