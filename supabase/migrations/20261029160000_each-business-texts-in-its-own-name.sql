-- BUILD-3 (#538): each business texts its clients from its own Twilio
-- subaccount, registered in that business's own name (toll-free verification
-- by default).
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────
--
--   org_texting_registrations   one row per business: the details the owner
--                               filed in Settings → Texting, the Twilio SIDs
--                               provisioning created, and the verification's
--                               status as Twilio last reported it.
--   activate_org_texting()      the ONLY writer of a provisioned credential:
--                               org_twilio_credentials and
--                               organizations.sms_from_number, in one
--                               transaction, and only once the verification
--                               is approved.
--   texting_status_due()        whether the status poll has anything to ask
--                               Twilio about, so the ten-minute job costs no
--                               HTTP while nothing is in review.
--   'booking' consent source    the public booking link records the client's
--                               opt-in (unticked, never required) the way the
--                               portal does.
--
-- ── WHAT IS NEVER STORED ──────────────────────────────────────────────────
--
-- The EIN goes to Twilio inside the submit request and is not written
-- anywhere: the row keeps its last four digits, and the CHECK below refuses
-- anything longer. The subaccount's auth token is not on the registration at
-- all. It is read from Twilio with the parent credentials when it is needed,
-- and stored once, encrypted (v1. envelope, lib/secret-encryption.server), by
-- activate_org_texting, which refuses a token that is not ciphertext.
--
-- ── WHY ACTIVATION IS A FUNCTION ──────────────────────────────────────────
--
-- `organizations.sms_from_number` is how the inbound webhook finds a business,
-- and `org_twilio_credentials` is what `endCustomerSmsSender` sends with. Two
-- writes from the app is two chances to leave one without the other: a number
-- that routes replies to a business that cannot send, or a sender whose replies
-- reach nobody. One SQL function is one transaction.
--
-- NOT APPLIED. Practice on a rolled-back copy first (approval:migration).

-- ── 1. The registration ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.org_texting_registrations (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft',
  number_type text NOT NULL DEFAULT 'toll_free',

  -- What the owner filed, exactly as on the EIN letter.
  legal_name text,
  business_type text,
  dba text,
  street text,
  street2 text,
  city text,
  region text,
  postal_code text,
  country text NOT NULL DEFAULT 'US',
  website_url text,
  privacy_url text,
  terms_url text,
  business_email text,
  business_phone text,
  -- Two authorized contacts: [{first_name, last_name, title, email, phone}].
  contacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ein_last4 text,

  -- What provisioning created, so a retry resumes rather than duplicates.
  subaccount_sid text,
  address_sid text,
  business_end_user_sid text,
  representative_end_user_sids text[] NOT NULL DEFAULT '{}',
  address_document_sid text,
  customer_profile_sid text,
  customer_profile_status text,
  phone_number_sid text,
  phone_number text,
  verification_sid text,
  verification_status text,

  -- What Twilio said, in its words; Settings turns it into plain ones.
  rejection_reason text,
  rejection_code text,
  resubmit_deadline timestamptz,
  last_error text,

  submitted_at timestamptz,
  approved_at timestamptz,
  -- When texting was switched on (activate_org_texting succeeded). Set from
  -- NULL once, by a conditional UPDATE, and the owner's "Texting is live"
  -- notice goes only with that first set.
  activated_at timestamptz,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  rejection_alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,

  CONSTRAINT org_texting_registrations_status_check CHECK (
    status IN ('draft', 'submitting', 'submitted', 'in_review', 'approved', 'rejected', 'failed')
  ),
  CONSTRAINT org_texting_registrations_number_type_check CHECK (
    number_type IN ('toll_free', 'local')
  ),
  -- Four digits or nothing. A full EIN here is a column nobody meant to keep.
  CONSTRAINT org_texting_registrations_ein_last4_check CHECK (
    ein_last4 IS NULL OR ein_last4 ~ '^[0-9]{4}$'
  ),
  CONSTRAINT org_texting_registrations_phone_check CHECK (
    phone_number IS NULL OR phone_number ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT org_texting_registrations_contacts_check CHECK (
    jsonb_typeof(contacts) = 'array'
  )
);

-- One business per subaccount, number and verification. Never shared.
CREATE UNIQUE INDEX IF NOT EXISTS org_texting_registrations_subaccount_key
  ON public.org_texting_registrations (subaccount_sid) WHERE subaccount_sid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS org_texting_registrations_phone_key
  ON public.org_texting_registrations (phone_number) WHERE phone_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS org_texting_registrations_verification_key
  ON public.org_texting_registrations (verification_sid) WHERE verification_sid IS NOT NULL;
-- What the status poll reads.
CREATE INDEX IF NOT EXISTS org_texting_registrations_open_idx
  ON public.org_texting_registrations (status) WHERE status IN ('submitted', 'in_review', 'approved');

COMMENT ON TABLE public.org_texting_registrations IS
  'One business''s Twilio subaccount, business profile, number and toll-free verification (#538). '
  'Service role only: read and written by lib/texting-registration.functions and the status poll. '
  'Never holds an EIN (last four only) or an auth token.';

ALTER TABLE public.org_texting_registrations ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.org_texting_registrations');

DROP TRIGGER IF EXISTS set_updated_at ON public.org_texting_registrations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.org_texting_registrations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 2. The one writer of a provisioned credential ─────────────────────────

CREATE OR REPLACE FUNCTION public.activate_org_texting(
  _org_id uuid,
  _account_sid text,
  _auth_token text,
  _token_last4 text,
  _from text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE _reg public.org_texting_registrations%ROWTYPE;
BEGIN
  SELECT * INTO _reg FROM public.org_texting_registrations WHERE organization_id = _org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No texting registration for this business';
  END IF;
  -- On approval only. A number still in review cannot send, and this is the
  -- line that makes that true: without the row, endCustomerSmsSender is null.
  IF _reg.status <> 'approved' THEN
    RAISE EXCEPTION 'Texting turns on only after the verification is approved (status is %)', _reg.status;
  END IF;
  IF _reg.subaccount_sid IS DISTINCT FROM _account_sid THEN
    RAISE EXCEPTION 'That subaccount is not this business''s';
  END IF;
  IF _reg.phone_number IS DISTINCT FROM _from THEN
    RAISE EXCEPTION 'That number is not this business''s';
  END IF;
  IF _from IS NULL OR _from !~ '^\+[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'The sender must be an E.164 number';
  END IF;
  -- Ciphertext or nothing. encryptSecret() writes "v1.<iv>.<tag>.<data>".
  IF _auth_token IS NULL OR _auth_token NOT LIKE 'v1.%' THEN
    RAISE EXCEPTION 'The auth token must be stored encrypted';
  END IF;
  IF _token_last4 IS NOT NULL AND length(_token_last4) <> 4 THEN
    RAISE EXCEPTION 'token_last4 is four characters';
  END IF;

  INSERT INTO public.org_twilio_credentials
    (organization_id, account_sid, auth_token, token_last4, sms_from_number, messaging_service_sid, updated_at)
  VALUES (_org_id, _account_sid, _auth_token, _token_last4, _from, NULL, now())
  ON CONFLICT (organization_id) DO UPDATE
    SET account_sid = EXCLUDED.account_sid,
        auth_token = EXCLUDED.auth_token,
        token_last4 = EXCLUDED.token_last4,
        sms_from_number = EXCLUDED.sms_from_number,
        messaging_service_sid = NULL,
        updated_at = now();

  UPDATE public.organizations SET sms_from_number = _from WHERE id = _org_id;
END;
$fn$;

COMMENT ON FUNCTION public.activate_org_texting(uuid, text, text, text, text) IS
  'Writes org_twilio_credentials and organizations.sms_from_number together, once the business''s '
  'toll-free verification is approved. Refuses a plaintext token. Service role only (#538).';

REVOKE ALL ON FUNCTION public.activate_org_texting(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_org_texting(uuid, text, text, text, text) TO service_role;

-- ── 3. Whether the poll has anything to ask ───────────────────────────────

CREATE OR REPLACE FUNCTION public.texting_status_due()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.org_texting_registrations r
     WHERE r.status IN ('submitted', 'in_review')
        -- Approved but not yet activated: the poll finishes the job.
        OR (r.status = 'approved'
            AND NOT EXISTS (SELECT 1 FROM public.org_twilio_credentials c
                             WHERE c.organization_id = r.organization_id))
  );
$fn$;

REVOKE ALL ON FUNCTION public.texting_status_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.texting_status_due() TO service_role;

-- ── 4. The booking link records consent ───────────────────────────────────

ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_sms_consent_source_check;
ALTER TABLE public.clients
  ADD CONSTRAINT clients_sms_consent_source_check
  CHECK (sms_consent_source IS NULL
         OR sms_consent_source IN ('portal', 'staff', 'import', 'reply', 'booking'));

-- What the visitor was shown and the number it covers, carried from the form
-- to the client the payment webhook creates. NULL when the box was not ticked.
ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS sms_consent_text text,
  ADD COLUMN IF NOT EXISTS sms_consent_phone text;

CREATE OR REPLACE FUNCTION public.record_client_sms_consent(
  _client_id uuid, _text text, _source text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _org uuid; _phone text;
BEGIN
  SELECT organization_id, primary_phone INTO _org, _phone
    FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'No such client'; END IF;

  -- The portal and the booking link have no user identity: both are the
  -- service-role client, called after a session token (portal) or a paid
  -- signup (booking) has been checked. Anything that DOES have an identity is
  -- a staff member and answers to can_write_org whatever source it claims.
  IF NOT (_source IN ('portal', 'booking') AND auth.uid() IS NULL)
     AND NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _source NOT IN ('portal', 'staff', 'import', 'reply', 'booking') THEN
    RAISE EXCEPTION 'Unknown consent source: %', _source;
  END IF;
  IF _phone IS NULL THEN
    RAISE EXCEPTION 'Add a phone number before recording texting consent';
  END IF;
  IF _text IS NULL OR length(btrim(_text)) < 10 THEN
    RAISE EXCEPTION 'The consent wording must be stored with the consent';
  END IF;

  UPDATE public.clients
     SET sms_consent_at = now(),
         sms_consent_phone = _phone,
         sms_consent_text = _text,
         sms_consent_source = _source,
         sms_opt_out = false
   WHERE id = _client_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_client_sms_consent(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_client_sms_consent(uuid, text, text) TO authenticated, service_role;

-- ── 5. Schedule the status poll ───────────────────────────────────────────
--
-- Every ten minutes, so a change at Twilio shows in Settings inside fifteen.
-- The command asks texting_status_due() first: with nothing in review it
-- makes no request at all.
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule('texting-status')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'texting-status');
    PERFORM cron.schedule('texting-status', '*/10 * * * *', $job$
  SELECT net.http_post(
      url := 'https://app.houndstack.com/api/public/hooks/texting-status',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'Authorization', 'Bearer ' || s.decrypted_secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
  ) AS request_id
    FROM vault.decrypted_secrets s
   WHERE s.name = 'cron_service_role_key'
     AND public.texting_status_due();
  $job$);
  ELSE
    RAISE WARNING 'pg_cron is not installed, so texting-status was NOT scheduled; a texting verification Twilio approves or rejects will not show in Settings until someone presses Check now';
  END IF;
END
$sched$;

-- ── 6. Check what this file established ───────────────────────────────────

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'org_texting_registrations'
                    AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'org_texting_registrations has no row level security';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'org_texting_registrations'
                AND permissive = 'PERMISSIVE') THEN
    RAISE EXCEPTION 'org_texting_registrations is service role only and must have no permissive policy';
  END IF;
  IF has_function_privilege('anon', 'public.activate_org_texting(uuid, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.activate_org_texting(uuid, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'activate_org_texting is executable by anon or authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.texting_status_due()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.texting_status_due()', 'EXECUTE') THEN
    RAISE EXCEPTION 'texting_status_due is executable by anon or authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.record_client_sms_consent(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'record_client_sms_consent is executable by anon';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'org_twilio_credentials'
                    AND column_name = 'token_last4') THEN
    RAISE EXCEPTION 'org_twilio_credentials.token_last4 is missing; activate_org_texting writes it';
  END IF;
END
$check$;
