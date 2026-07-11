-- Frictionless signup (Brendan's re-review): accounts are auto-confirmed so
-- new owners get straight into the app; email verification becomes a to-do
-- tracked here, and Stripe Express is locked until it's done.
alter table public.organizations
  add column if not exists email_verified_at timestamptz;

-- Orgs that existed before this change were created under the old
-- confirm-first flow — treat them as verified so nothing locks retroactively.
update public.organizations set email_verified_at = now() where email_verified_at is null;

create table if not exists public.email_verifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  token uuid not null default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  verified_at timestamptz
);

create index if not exists email_verifications_token_idx on public.email_verifications(token);

-- Service-role only: tokens are minted and consumed server-side.
alter table public.email_verifications enable row level security;
