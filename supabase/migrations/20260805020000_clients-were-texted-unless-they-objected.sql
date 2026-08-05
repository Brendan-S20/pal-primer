-- Twilio rejected toll-free verification: 30513, "Opt-in — Consent for
-- messaging is a requirement for service".
--
-- ── WHY IT WAS REJECTED, AND WHY REWORDING WOULD NOT HAVE HELPED ──────────
--
-- The submission could not describe an opt-in because there was not one.
--
--   organizations.sms_consent_at / _phone / _text   <- real consent, captured
--   clients.sms_opt_out                             <- a boolean, default false
--
-- The org columns are the TENANT agreeing to receive texts from HoundStack,
-- with a timestamp, the number, and the verbatim text they were shown. That is
-- exactly the shape a carrier wants. The clients table has none of it: a client
-- was textable the moment somebody typed their phone number, and the only
-- record of anything was `sms_opt_out` flipping to true AFTER they replied
-- STOP. Consent was assumed and only ever recorded by its absence.
--
-- Toll-free verification asks how end users consent. "They are texted unless
-- they object" is not consent, and no rewriting of the submission makes it one.
-- This changes the data model instead.
--
-- ── WHAT CONSENT NOW MEANS ────────────────────────────────────────────────
--
-- Four columns mirroring the organizations pattern, because it already had the
-- right shape:
--
--   sms_consent_at      when. NULL means no consent on file — not "unknown",
--                       not "probably fine". The send guard treats NULL as no.
--   sms_consent_phone   the number consent was given FOR. If the client later
--                       changes their number, the consent does not silently
--                       follow it to a stranger's handset — see the trigger.
--   sms_consent_text    the exact words shown at the time. Carriers ask for
--                       this verbatim, and a pointer to whatever the current
--                       copy happens to say is not evidence about a consent
--                       captured eight months ago.
--   sms_consent_source  how it was collected: 'portal', 'staff', 'import',
--                       'reply'. An audit needs to distinguish a client who
--                       ticked a box themselves from one a staff member
--                       recorded on their behalf.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
--
-- It does NOT backfill consent for existing clients. That is the entire point:
-- inventing a consent timestamp for every client already in the table would
-- reproduce the exact fiction the carrier rejected, and would be worse than
-- the original because it would look like evidence. Existing clients start
-- with no consent on file and must be asked. The portal opt-in and the staff
-- form exist so that is a small job rather than an impossible one.
--
-- It does NOT remove `sms_opt_out`. Consent and refusal are different facts and
-- both matter: a client who consented in March and replied STOP in June is not
-- the same as one who never answered. STOP must always win, and it does — the
-- guard checks opt-out first.

-- Digits-only comparison, so "+1 (512) 555-0100" and "5125550100" are the same
-- number and re-formatting a phone does not destroy a valid consent.
CREATE OR REPLACE FUNCTION public.phone_digits(_p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT NULLIF(regexp_replace(COALESCE(_p, ''), '[^0-9]', '', 'g'), ''); $$;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS sms_consent_at     timestamptz,
  ADD COLUMN IF NOT EXISTS sms_consent_phone  text,
  ADD COLUMN IF NOT EXISTS sms_consent_text   text,
  ADD COLUMN IF NOT EXISTS sms_consent_source text;

ALTER TABLE public.clients
  DROP CONSTRAINT IF EXISTS clients_sms_consent_source_check;
ALTER TABLE public.clients
  ADD CONSTRAINT clients_sms_consent_source_check
  CHECK (sms_consent_source IS NULL
         OR sms_consent_source IN ('portal', 'staff', 'import', 'reply'));

-- Consent is only meaningful with the evidence attached. A timestamp on its own
-- is the thing a carrier will not accept, so the table refuses to store it.
ALTER TABLE public.clients
  DROP CONSTRAINT IF EXISTS clients_sms_consent_complete;
ALTER TABLE public.clients
  ADD CONSTRAINT clients_sms_consent_complete
  CHECK (
    sms_consent_at IS NULL
    OR (sms_consent_phone IS NOT NULL
        AND sms_consent_text IS NOT NULL
        AND sms_consent_source IS NOT NULL)
  );

COMMENT ON COLUMN public.clients.sms_consent_at IS
  'When this client agreed to receive texts. NULL means no consent on file and '
  'the client must not be texted. Never backfilled — see migration 20260805020000.';
COMMENT ON COLUMN public.clients.sms_consent_text IS
  'The verbatim words shown when consent was given. Carriers ask for this; a '
  'pointer to current copy is not evidence about a consent captured months ago.';

-- ── Consent does not follow a changed number ──────────────────────────────
--
-- Phone numbers get recycled and mistyped. A client who consented on
-- 555-0100 has told you nothing about the person now reachable on 555-0199,
-- and texting that person is precisely the complaint that gets a toll-free
-- number shut off. Changing the number clears the consent, which is visible in
-- the UI as "no consent on file" rather than failing silently.

CREATE OR REPLACE FUNCTION public.tg_client_phone_change_clears_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.sms_consent_at IS NOT NULL
     AND NEW.sms_consent_phone IS NOT NULL
     AND public.phone_digits(NEW.primary_phone) IS DISTINCT FROM
         public.phone_digits(NEW.sms_consent_phone)
     -- Only when the row is not ALREADY re-consenting in this same write.
     -- Recording new consent and the new number together is the normal path
     -- and must not be undone by this trigger.
     AND NEW.sms_consent_at IS NOT DISTINCT FROM OLD.sms_consent_at
  THEN
    NEW.sms_consent_at := NULL;
    NEW.sms_consent_phone := NULL;
    NEW.sms_consent_text := NULL;
    NEW.sms_consent_source := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clients_phone_change_clears_consent ON public.clients;
CREATE TRIGGER clients_phone_change_clears_consent
  BEFORE UPDATE OF primary_phone, sms_consent_phone ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.tg_client_phone_change_clears_consent();

-- ── The one question every sender must ask ────────────────────────────────

CREATE OR REPLACE FUNCTION public.client_may_be_texted(_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.clients c
     WHERE c.id = _client_id
       -- STOP always wins, whatever consent says. A client who consented in
       -- March and replied STOP in June has refused.
       AND c.sms_opt_out = false
       AND COALESCE(c.comms_paused, false) = false
       AND c.sms_consent_at IS NOT NULL
       AND c.primary_phone IS NOT NULL
       -- The number on file must still be the number consented to. The trigger
       -- above normally keeps these in step; this is the backstop for rows
       -- written before it existed or by a path that bypasses it.
       AND public.phone_digits(c.primary_phone)
           IS NOT DISTINCT FROM public.phone_digits(c.sms_consent_phone)
  );
$$;

COMMENT ON FUNCTION public.client_may_be_texted(uuid) IS
  'True only with consent on file, for the current number, not opted out and '
  'not paused. NULL consent is a no. Every SMS path must pass this.';

GRANT EXECUTE ON FUNCTION public.client_may_be_texted(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phone_digits(text)         TO authenticated;

-- ── Recording consent ─────────────────────────────────────────────────────
--
-- A function rather than a direct UPDATE so the four columns are always
-- written together and the number consented to is always the number on the
-- row. Three separate call sites doing it by hand is how one of them ends up
-- storing a timestamp with no text.

CREATE OR REPLACE FUNCTION public.record_client_sms_consent(
  _client_id uuid,
  _text      text,
  _source    text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE _org uuid; _phone text;
BEGIN
  SELECT organization_id, primary_phone INTO _org, _phone
    FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'No such client'; END IF;

  -- 'portal' is the client acting on their own behalf through a tokenised
  -- link, where there is no session to authorise. Every other source is a
  -- staff action and must be authorised as one.
  IF _source <> 'portal' AND NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _source NOT IN ('portal', 'staff', 'import', 'reply') THEN
    RAISE EXCEPTION 'Unknown consent source: %', _source;
  END IF;
  IF _phone IS NULL THEN
    RAISE EXCEPTION 'Add a phone number before recording texting consent';
  END IF;
  IF _text IS NULL OR length(btrim(_text)) < 10 THEN
    -- The stored text IS the evidence. An empty string would satisfy the
    -- CHECK constraint and prove nothing.
    RAISE EXCEPTION 'The consent wording must be stored with the consent';
  END IF;

  UPDATE public.clients
     SET sms_consent_at = now(),
         sms_consent_phone = _phone,
         sms_consent_text = _text,
         sms_consent_source = _source,
         -- Consenting is the opposite of STOP. Somebody who opted out and has
         -- now opted back in should not stay blocked by the old flag.
         sms_opt_out = false
   WHERE id = _client_id;
END;
$$;

COMMENT ON FUNCTION public.record_client_sms_consent(uuid, text, text) IS
  'Writes the four consent columns together, stamped with the phone currently '
  'on the client. Clears sms_opt_out, since consenting reverses a STOP.';

GRANT EXECUTE ON FUNCTION public.record_client_sms_consent(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_client_sms_consent(uuid, text, text) TO anon;

-- ── How much of the book has consent ──────────────────────────────────────
--
-- Feeds the banner telling an owner how many clients they can actually text,
-- so the gap is a number on screen rather than a mystery about why reminders
-- stopped going out.

CREATE OR REPLACE FUNCTION public.sms_consent_coverage(_org_id uuid)
RETURNS TABLE (with_phone integer, consented integer, opted_out integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*) FILTER (WHERE primary_phone IS NOT NULL)::int,
    count(*) FILTER (WHERE sms_consent_at IS NOT NULL
                       AND public.phone_digits(primary_phone)
                           IS NOT DISTINCT FROM public.phone_digits(sms_consent_phone))::int,
    count(*) FILTER (WHERE sms_opt_out)::int
  FROM public.clients
  WHERE organization_id = _org_id
    AND active
    AND public.is_org_member(auth.uid(), _org_id);
$$;

GRANT EXECUTE ON FUNCTION public.sms_consent_coverage(uuid) TO authenticated;
