
REVOKE ALL ON FUNCTION public.has_role(uuid, uuid, public.app_role) FROM public, authenticated, anon;
REVOKE ALL ON FUNCTION public.is_org_member(uuid, uuid) FROM public, authenticated, anon;
REVOKE ALL ON FUNCTION public.can_write_org(uuid, uuid) FROM public, authenticated, anon;
REVOKE ALL ON FUNCTION public.refresh_active_client_count(uuid) FROM public, authenticated, anon;
REVOKE ALL ON FUNCTION public.tg_clients_maintain_count() FROM public, authenticated, anon;
