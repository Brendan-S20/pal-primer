
CREATE OR REPLACE FUNCTION public.portal_get_referral(_token uuid)
RETURNS TABLE(referral_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.referral_code
    FROM public.clients c
   WHERE c.portal_token = _token AND c.active = true
$$;
GRANT EXECUTE ON FUNCTION public.portal_get_referral(uuid) TO anon, authenticated;
