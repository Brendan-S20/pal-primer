
DROP POLICY IF EXISTS "Authenticated can read leads" ON public.leads;
DROP POLICY IF EXISTS "Authenticated can update leads" ON public.leads;
DROP POLICY IF EXISTS "Authenticated can delete leads" ON public.leads;

CREATE POLICY "Managers can read leads" ON public.leads FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.role IN ('owner','office_manager')));

CREATE POLICY "Managers can update leads" ON public.leads FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.role IN ('owner','office_manager')))
WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.role IN ('owner','office_manager')));

CREATE POLICY "Managers can delete leads" ON public.leads FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.role IN ('owner','office_manager')));

ALTER FUNCTION public.enqueue_email(text, jsonb) SET search_path = public;
ALTER FUNCTION public.read_email_batch(text, integer, integer) SET search_path = public;
ALTER FUNCTION public.delete_email(text, bigint) SET search_path = public;
ALTER FUNCTION public.move_to_dlq(text, text, bigint, jsonb) SET search_path = public;

DO $$
DECLARE
  keep_anon text[] := ARRAY[
    'bootstrap_organization','apply_referral_code',
    'enqueue_email','read_email_batch','delete_email','move_to_dlq','email_queue_dispatch','email_queue_wake'
  ];
  r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef=true
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND p.proname <> ALL(keep_anon)
      AND p.proname NOT LIKE 'portal\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM anon, PUBLIC', r.proname, r.args);
  END LOOP;
END$$;
