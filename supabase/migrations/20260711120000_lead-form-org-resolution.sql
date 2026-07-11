-- Lead-form org resolution (launch punch list #3): Settings hands out
-- /lead/{portal_slug} links, but public_get_org_by_slug matches only
-- organizations.slug AND requires public_signup_enabled = true — so every
-- hosted lead form returned "This form isn't available." Lead capture is not
-- signup: resolve by portal_slug (legacy slug still accepted) and don't gate
-- on public_signup_enabled. public_get_org_by_slug is left untouched for the
-- signup flow, where the gate is correct.
create or replace function public.public_get_org_for_lead_form(_slug text)
returns table(id uuid, name text)
language sql
stable security definer
set search_path to 'public'
as $$
  select o.id, o.name
  from public.organizations o
  where o.portal_slug = _slug or o.slug = _slug
  order by (o.portal_slug = _slug) desc nulls last
  limit 1;
$$;

grant execute on function public.public_get_org_for_lead_form(text) to anon, authenticated;
