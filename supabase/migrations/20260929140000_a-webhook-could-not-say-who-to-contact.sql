-- A webhook could not say who to contact.
--
-- Webhook payloads (20260929080000) carry ids, names, amounts and dates, and
-- never an email or phone number. That was deliberate: an endpoint is a URL
-- somebody pasted, and contact details are the part of a customer record
-- that is most useful to whoever receives it. But the commonest thing an
-- owner builds with a webhook is "new client -> add to my mailing list" or
-- "visit completed -> text a review request", and both need exactly that.
--
-- The owner's decision (2026-09-29): an opt-in per endpoint, off by default.
--
--   webhook_endpoints.include_contact   false unless the owner ticks it for
--                                       this endpoint.
--   webhook_contact_for(...)            the email and phone of the client or
--                                       lead an event is about, returned ONLY
--                                       for an endpoint that opted in and only
--                                       for a record in the endpoint's own
--                                       organization. Service-role only; the
--                                       delivery worker adds it to the body
--                                       at send time, so nothing already
--                                       queued changes shape, and switching
--                                       the option off stops it for every
--                                       delivery not yet sent.
--
-- The signed-in role could update three columns of an endpoint
-- (description, events, enabled); include_contact is the fourth.
--
-- Replays into an empty database: one column, one grant, one function. The
-- DO block asserts only what this file establishes.

ALTER TABLE public.webhook_endpoints
  ADD COLUMN IF NOT EXISTS include_contact boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.webhook_endpoints.include_contact IS
  'Whether deliveries to this endpoint carry the client''s or lead''s email and phone. Off unless the owner turns it on for this endpoint.';

GRANT UPDATE (include_contact) ON public.webhook_endpoints TO authenticated;

CREATE OR REPLACE FUNCTION public.webhook_contact_for(
  _endpoint_id uuid,
  _client_id uuid,
  _lead_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid;
  _on boolean;
  _email text;
  _phone text;
BEGIN
  SELECT organization_id, include_contact INTO _org, _on
    FROM public.webhook_endpoints WHERE id = _endpoint_id;
  IF _org IS NULL OR NOT COALESCE(_on, false) THEN
    RETURN NULL;
  END IF;

  IF _client_id IS NOT NULL THEN
    SELECT c.primary_email, c.primary_phone INTO _email, _phone
      FROM public.clients c
     WHERE c.id = _client_id AND c.organization_id = _org;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSIF _lead_id IS NOT NULL THEN
    SELECT l.email, l.phone INTO _email, _phone
      FROM public.leads l
     WHERE l.id = _lead_id AND l.organization_id = _org;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object('email', _email, 'phone', _phone);
END
$function$;

REVOKE ALL ON FUNCTION public.webhook_contact_for(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_contact_for(uuid, uuid, uuid) TO service_role;

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'webhook_endpoints'
       AND column_name = 'include_contact' AND is_nullable = 'NO' AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'webhook_endpoints.include_contact is missing, nullable, or not off by default';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.webhook_endpoints', 'include_contact', 'UPDATE') THEN
    RAISE EXCEPTION 'an owner cannot switch include_contact';
  END IF;
  IF has_function_privilege('anon', 'public.webhook_contact_for(uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.webhook_contact_for(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'webhook_contact_for is callable by an API role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.webhook_contact_for(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute webhook_contact_for';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.webhook_contact_for(uuid, uuid, uuid)'::regprocedure)
       !~ 'organization_id = _org' THEN
    RAISE EXCEPTION 'webhook_contact_for does not keep contact details inside the endpoint''s organization';
  END IF;
END
$check$;
