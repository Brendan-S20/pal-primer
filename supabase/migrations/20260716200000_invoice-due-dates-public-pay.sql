-- QA round 8, invoice layer: due dates + public pay links.
--
-- 1. Due dates: invoices.due_on, org-level payment terms (net days), and a
--    BEFORE INSERT trigger so EVERY creation path (manual server fn, the
--    generate_invoice_for_client / generate_invoices_for_org RPCs, prepaid
--    top-ups, portal top-ups, nightly auto-invoicing) gets a due date without
--    each path needing to remember to set one.
-- 2. Public pay link: invoices.public_token, an unguessable capability token
--    for the no-auth /pay/i/{token} page.

alter table public.invoices add column if not exists due_on date;
alter table public.organizations add column if not exists invoice_net_days integer not null default 15;

alter table public.invoices add column if not exists public_token uuid not null default gen_random_uuid();
create unique index if not exists invoices_public_token_key on public.invoices (public_token);

-- Default due_on = issued date + the org's net days. Application code may set
-- due_on explicitly; the trigger only fills the gap.
create or replace function public.tg_set_invoice_due_on()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  _net integer;
begin
  if new.due_on is null then
    select coalesce(o.invoice_net_days, 15) into _net
      from public.organizations o where o.id = new.organization_id;
    new.due_on := coalesce(new.issued_at::date, current_date) + coalesce(_net, 15);
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_set_due_on on public.invoices;
create trigger invoices_set_due_on
before insert on public.invoices
for each row execute function public.tg_set_invoice_due_on();

-- Backfill: existing invoices get issued date + the org's current net days
-- so the index/drawer overdue treatment works on historical open invoices.
update public.invoices i
   set due_on = coalesce(i.issued_at::date, i.created_at::date)
                + coalesce(o.invoice_net_days, 15)
  from public.organizations o
 where o.id = i.organization_id
   and i.due_on is null;
