-- Customer emails that never say how to reach the company that sent them.
--
-- Every template in src/lib/email-templates ends the same way: a sentence, a
-- button, and nothing else. "Your yard cleanup is complete." — from whom?
-- `orgName` reaches the body of some of them, but no template renders a phone
-- number, a postal address, or even a reply-to hint. A homeowner who wants to
-- ask about the visit has to go find an old text.
--
-- `organizations` already carries `contact_phone` and `contact_email`, both
-- editable in Settings → Preferences, both used elsewhere. Neither was ever
-- put in an email footer. So most of this is a rendering fix.
--
-- The one thing genuinely missing is a postal address, which this adds.
--
-- ── WHY AN ADDRESS, WHEN NOTHING RENDERS IT YET ───────────────────────────
--
-- Two reasons, and the second is the one that matters.
--
-- Legally: CAN-SPAM requires a valid physical postal address in commercial
-- email. Most of what this product sends is transactional (a receipt, a
-- completed visit) and largely outside that requirement — but `win-back` and
-- `review-request` are marketing by any reading, and they go to the same
-- template pipeline. A field that exists can be required later; a field that
-- does not exist makes the question unanswerable.
--
-- Practically: a service business's address is how a customer knows the
-- company is real and local. It is the single most reassuring line in a
-- footer from a company you have met once, in a truck.
--
-- Free text on purpose, one field rather than street/city/state/postal.
-- Splitting it would imply this is an address the software reasons about — it
-- is not routed to, geocoded, or validated against anything. It is printed.
-- A single field also survives the tenants who trade from a PO box or a
-- registered agent, which a street/city/state form quietly does not.
--
-- Nothing is backfilled and nothing is required. An org that has not set one
-- gets a footer without that line, which is the current behaviour and not a
-- regression.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS contact_address text;

COMMENT ON COLUMN public.organizations.contact_address IS
  'Business postal address as the customer should see it, free text, one field. Printed in email footers; never parsed, geocoded or routed to. NULL means the footer omits the line.';

-- A label, not a location: guard against someone pasting a novel into it, and
-- against the empty string, which renders as a blank line rather than as
-- "unset".
ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_contact_address_chk;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_contact_address_chk
  CHECK (contact_address IS NULL OR (length(btrim(contact_address)) BETWEEN 1 AND 300));

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='organizations'
       AND column_name='contact_address'
  ) THEN
    RAISE EXCEPTION 'contact_address was not added';
  END IF;
  -- The empty string has to be rejected, or "set but blank" and "not set"
  -- render differently for no reason a tenant could predict.
  BEGIN
    PERFORM 1 FROM public.organizations WHERE contact_address = '';
    IF EXISTS (SELECT 1 FROM public.organizations WHERE contact_address = '') THEN
      RAISE EXCEPTION 'existing rows hold an empty contact_address';
    END IF;
  END;
END
$post$;
