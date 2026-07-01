
REVOKE EXECUTE ON FUNCTION public.admin_generate_visits_through(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_generate_invoices_for_org(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_generate_visits_through(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_generate_invoices_for_org(uuid, date) TO service_role;
