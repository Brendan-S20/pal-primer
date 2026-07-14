-- Feature 2: tenants can watch their referrals' progress, but RLS (correctly)
-- blocks them from reading other orgs' rows in `organizations` — so the
-- referred business's display name comes through this SECURITY DEFINER read,
-- scoped to the caller's own org and exposing nothing but name + progress.
CREATE OR REPLACE FUNCTION public.get_my_tenant_referrals()
RETURNS TABLE (
  id uuid,
  referred_org_name text,
  status text,
  flagged boolean,
  reward_cents integer,
  eligible_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT tr.id,
         o.name AS referred_org_name,
         tr.status,
         tr.flagged,
         tr.reward_cents,
         tr.eligible_at,
         tr.paid_at,
         tr.created_at
    FROM public.tenant_referrals tr
    JOIN public.organizations o ON o.id = tr.referred_org_id
   WHERE tr.referrer_org_id IN (
           SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
         )
   ORDER BY tr.created_at DESC;
$fn$;
