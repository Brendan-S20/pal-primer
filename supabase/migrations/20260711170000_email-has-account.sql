-- Identifier-first sign-in (ERP-style auth rework): the server needs to know
-- whether an email already has an account to branch sign-in vs. create-account.
-- SECURITY DEFINER to read auth.users; execute restricted to service_role so
-- the browser can never call it directly (enumeration goes through our server
-- fn only).
create or replace function public.email_has_account(_email text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists(select 1 from auth.users where lower(email) = lower(_email));
$$;

revoke execute on function public.email_has_account(text) from public;
revoke execute on function public.email_has_account(text) from anon;
revoke execute on function public.email_has_account(text) from authenticated;
grant execute on function public.email_has_account(text) to service_role;
