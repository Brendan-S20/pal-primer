
CREATE OR REPLACE FUNCTION public.tg_clients_gen_referral_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public','extensions'
AS $function$
DECLARE _try text; _n int := 0;
BEGIN
  IF NEW.referral_code IS NOT NULL THEN RETURN NEW; END IF;
  LOOP
    _try := upper(substr(replace(encode(extensions.gen_random_bytes(4),'base64'),'/',''), 1, 6));
    _try := regexp_replace(_try, '[^A-Z0-9]', 'X', 'g');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.clients
       WHERE organization_id = NEW.organization_id AND lower(referral_code) = lower(_try)
    );
    _n := _n + 1;
    IF _n > 8 THEN _try := _try || floor(random()*1000)::text; EXIT; END IF;
  END LOOP;
  NEW.referral_code := _try;
  RETURN NEW;
END; $function$;
