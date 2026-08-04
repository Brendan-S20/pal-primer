-- The `leads` INSERT policy was `WITH CHECK (true)`.
--
-- ── WHAT THAT ALLOWED ─────────────────────────────────────────────────────
--
-- The lead form is public by design, so it runs on the PUBLISHABLE key — the
-- one shipped to every browser. `WITH CHECK (true)` means anyone holding that
-- key can POST straight to `/rest/v1/leads`, skipping both application paths
-- (`submitLead` and `/api/public/leads`), and write:
--
--   * a lead into ANY organization_id. Not a guess: `public_get_org_for_lead_form`
--     is SECURITY DEFINER, granted to anon, and RETURNS THE ORG UUID for any
--     slug — so the identifier needed to target a competitor is a documented
--     public lookup away. The payload lands in that tenant's pipeline, in their
--     notification centre, and in the `name`/`message` fields their staff read.
--
--   * `organization_id = NULL`. The column is nullable with no default, and the
--     SELECT policy requires a matching org — so an orphan lead is invisible to
--     every tenant AND to every tenant's delete. It accumulates and nobody can
--     see or remove it.
--
--   * `status`, `contacted_at`, `converted_at` set to anything. A lead that
--     arrives already `converted` is not just noise: it is a false entry in the
--     conversion figures the platform overview and the weekly digest report.
--
-- Both application paths already resolve `organization_id` from the slug and
-- never trust a client-supplied one. This is the layer underneath them, which
-- is the layer that was open — the same shape as the `seed_demo_org` finding
-- (one gate at the top, the table beneath it open to everyone who gets past it)
-- and the `ai_usage_state` finding before that.
--
-- ── WHY THE CONDITION NEEDS A SECURITY DEFINER FUNCTION ───────────────────
--
-- The obvious policy body is an inline
-- `EXISTS (SELECT 1 FROM organizations o WHERE o.id = leads.organization_id …)`.
-- It does not work, and it fails in the WORST direction: that subquery runs as
-- the caller, `anon` cannot read `organizations` under its own RLS, so the
-- EXISTS is false for every row and the policy rejects EVERY submission —
-- including the real form's. Written and caught by probing the policy as `anon`
-- before committing it; the lead form would otherwise have been silently dead
-- on arrival, which is precisely the failure that let the original
-- `WITH CHECK (true)` get written in the first place.
--
-- So the rule lives in a SECURITY DEFINER function, the same way `is_org_member`
-- and `has_permission` do, and it sits next to `public_get_org_for_lead_form`
-- because the two have to agree about what "publishes a lead form" means.
--
-- ── WHAT THE REPLACEMENT ASSERTS ──────────────────────────────────────────
--
--   1. It names a real organization. Not null, not soft-deleted.
--   2. That organization publishes a lead form — the SAME condition
--      `public_get_org_for_lead_form` resolves on (`portal_slug` or `slug`), so
--      a tenant with no public form cannot receive anonymous leads at all.
--   3. It is brand new. `status = 'new'`, nothing contacted, nothing converted.
--      Staff move a lead through those states via the UPDATE policy, which is
--      already org-scoped and role-gated.
--
-- What it deliberately does NOT do:
--
--   * Constrain `source`. Both callers pass user input (`data.source ||
--     'website'`), the column is free text, and an allowlist would reject
--     legitimate submissions the moment someone adds a campaign tag. The live
--     data holds 'website' and 'referral'; guessing the full set is how a
--     policy starts rejecting real customers.
--   * Rate-limit. Anyone can still submit through the real form as often as
--     they like — inherent to a public form, and a throttling problem rather
--     than an authorization one. Stated so nobody reads this as spam
--     protection.
--
-- The service role bypasses RLS, so the AI receptionist's lead insert
-- (`ai-receptionist.server.ts`, `source = 'sms_receptionist'`) is unaffected.
--
-- Verified before writing: 9 live leads, 0 orphans — nothing existing violates
-- the new rule.

CREATE OR REPLACE FUNCTION public.org_accepts_public_leads(_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = _org_id
       AND o.deleted_at IS NULL
       -- The same resolution public_get_org_for_lead_form performs. If that
       -- changes, this changes with it, or the policy stops describing which
       -- businesses actually have a form to submit through.
       AND (o.portal_slug IS NOT NULL OR o.slug IS NOT NULL)
  );
$$;

COMMENT ON FUNCTION public.org_accepts_public_leads(uuid) IS
  'Does this organization publish a public lead form? SECURITY DEFINER because the leads INSERT policy needs it and anon cannot read organizations — an inline EXISTS there evaluates false for every caller and rejects the real form.';

REVOKE ALL ON FUNCTION public.org_accepts_public_leads(uuid) FROM PUBLIC;
-- anon needs it: the lead form is anonymous, and the policy calls this as the
-- submitting role. It discloses one boolean about a business that publishes a
-- public form by definition.
GRANT EXECUTE ON FUNCTION public.org_accepts_public_leads(uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Anyone can submit a lead" ON public.leads;
DROP POLICY IF EXISTS "Anyone can submit a lead to a business that publishes a form" ON public.leads;

CREATE POLICY "Anyone can submit a lead to a business that publishes a form"
  ON public.leads
  FOR INSERT
  WITH CHECK (
    organization_id IS NOT NULL
    AND public.org_accepts_public_leads(organization_id)
    -- A submission is always a new, untouched lead. Anything else is the
    -- submitter writing into the tenant's own workflow state.
    AND status = 'new'
    AND contacted_at IS NULL
    AND converted_at IS NULL
  );

COMMENT ON POLICY "Anyone can submit a lead to a business that publishes a form" ON public.leads IS
  'Replaces WITH CHECK (true), which let any holder of the publishable key write a lead into any organization_id — or into none at all, creating rows no tenant could see or delete.';
