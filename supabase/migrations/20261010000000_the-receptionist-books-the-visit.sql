-- The receptionist books the visit.
--
-- Owner decision, 2026-10-09: build booking into the AI receptionist, so the
-- site's wording becomes true -- it "will answer client texts about pricing
-- and availability and book straight into the calendar". Until now its prompt
-- forbade offering any visit time at all.
--
-- It books nothing new. A client who texts asks for an extra cleanup through
-- the same path the portal uses (portal_request_one_off, then
-- bookOneOffVisit when the owner lets requests book themselves), and the days
-- it offers are the portal's days (bookableDays) less the ones no technician
-- can work (routable_staff) and the ones the address already has a visit. See
-- src/lib/receptionist-booking.ts. What the database needs for that is small:
--
-- 1. public.ai_receptionist_offers -- what the receptionist OFFERED, per
--    conversation. A text conversation spans several webhook calls ("Tue or
--    Thu?" ... "Thu please"), and the model's memory of what it offered is the
--    one thing that must not decide what gets booked. So every day
--    get_open_slots offers is written here, and book_visit books only a day it
--    finds here, unexpired, for the same business, the same phone and the
--    same address. The row is also what makes a repeated "yes book it" book
--    once: claimed_at is taken with a conditional UPDATE before anything is
--    written, and outcome records what happened, which a second message reads
--    back instead of booking again.
--
--      conversation_key  the sender's phone, digits only. Per business: the
--                        unique key leads with organization_id, so the same
--                        phone texting two businesses is two conversations.
--      target            the address the offer is for: the property id for a
--                        known client, 'zip:<code>' for an unknown number
--                        (which is never booked, only turned into a lead).
--
--    Service role only. The webhook is the only writer and the only reader;
--    the office sees the result where it already looks (a visit, a request in
--    Concerns, a lead), not this table.
--
-- 2. subscriptions.booked_via -- who booked a one-off: 'ai_receptionist' for
--    this path. NULL means "not recorded", which is every row before this
--    file and everything the office books, so nothing existing changes. The
--    visit drawer reads it through the subscription it already joins.
--
-- 3. qc_tickets.requested_via -- the same for an extra-cleanup request that
--    waits for the office: 'ai_receptionist' when it came by text, NULL for
--    the portal (as every existing request is).
--
-- Replays into an empty database: one table, two nullable columns, grants and
-- the two-step policy. The DO block at the end asserts only what this file
-- creates.

-- ── 1. what was offered ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_receptionist_offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_key text NOT NULL,
  client_id        uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  property_id      uuid REFERENCES public.properties(id) ON DELETE CASCADE,
  postal_code      text,
  target           text GENERATED ALWAYS AS (
                     COALESCE(property_id::text, 'zip:' || COALESCE(postal_code, ''))
                   ) STORED,
  day              date NOT NULL,
  window_start     time,
  window_end       time,
  offered_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  claimed_at       timestamptz,
  outcome          text,
  settled_at       timestamptz,
  visit_id         uuid REFERENCES public.visits(id) ON DELETE SET NULL,
  ticket_id        uuid REFERENCES public.qc_tickets(id) ON DELETE SET NULL,
  lead_id          uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  CONSTRAINT ai_receptionist_offers_key_is_digits CHECK (conversation_key ~ '^[0-9]{7,15}$'),
  -- An offer is for an address: a known client's property, or the ZIP an
  -- unknown number gave. Never neither.
  CONSTRAINT ai_receptionist_offers_has_a_target CHECK (property_id IS NOT NULL OR postal_code IS NOT NULL),
  -- A property offer belongs to a client; a ZIP offer to nobody yet.
  CONSTRAINT ai_receptionist_offers_property_has_client CHECK (property_id IS NULL OR client_id IS NOT NULL),
  CONSTRAINT ai_receptionist_offers_outcome CHECK (
    outcome IS NULL OR outcome IN ('booked', 'requested', 'lead', 'handed_off')
  ),
  CONSTRAINT ai_receptionist_offers_expiry CHECK (expires_at > offered_at),
  CONSTRAINT ai_receptionist_offers_one_per_day UNIQUE (organization_id, conversation_key, day, target)
);

CREATE INDEX IF NOT EXISTS ai_receptionist_offers_client_idx ON public.ai_receptionist_offers (client_id);
CREATE INDEX IF NOT EXISTS ai_receptionist_offers_property_idx ON public.ai_receptionist_offers (property_id);
CREATE INDEX IF NOT EXISTS ai_receptionist_offers_visit_idx ON public.ai_receptionist_offers (visit_id);
CREATE INDEX IF NOT EXISTS ai_receptionist_offers_ticket_idx ON public.ai_receptionist_offers (ticket_id);
CREATE INDEX IF NOT EXISTS ai_receptionist_offers_lead_idx ON public.ai_receptionist_offers (lead_id);

COMMENT ON TABLE public.ai_receptionist_offers IS
  'Days the AI receptionist offered in a text conversation. book_visit books only a day found here; claimed_at and outcome make a repeated booking message book once. Service role only.';

ALTER TABLE public.ai_receptionist_offers ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.ai_receptionist_offers');
-- No policy for any client role: the default privileges on public hand every
-- new table to anon and authenticated, so take that back as well.
REVOKE ALL ON public.ai_receptionist_offers FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ai_receptionist_offers TO service_role;

-- ── 2. and 3. who asked ─────────────────────────────────────────────────────

ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS booked_via text;
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_booked_via_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_booked_via_check
  CHECK (booked_via IS NULL OR booked_via IN ('ai_receptionist'));
COMMENT ON COLUMN public.subscriptions.booked_via IS
  'Who booked this service when it was not the office: ai_receptionist. NULL = not recorded (the office, and everything before 20261010000000).';

ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS requested_via text;
ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_requested_via_check;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_requested_via_check
  CHECK (requested_via IS NULL OR requested_via IN ('ai_receptionist'));
COMMENT ON COLUMN public.qc_tickets.requested_via IS
  'ai_receptionist when the client asked by text; NULL for the portal.';

-- ── what this file establishes ──────────────────────────────────────────────

DO $check$
BEGIN
  IF to_regclass('public.ai_receptionist_offers') IS NULL THEN
    RAISE EXCEPTION 'ai_receptionist_offers was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_receptionist_offers'::regclass) THEN
    RAISE EXCEPTION 'ai_receptionist_offers does not have row level security enabled';
  END IF;
  IF has_table_privilege('anon', 'public.ai_receptionist_offers', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ai_receptionist_offers', 'SELECT')
     OR has_table_privilege('anon', 'public.ai_receptionist_offers', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_receptionist_offers', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_receptionist_offers', 'UPDATE') THEN
    RAISE EXCEPTION 'ai_receptionist_offers is readable or writable by a client role';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.ai_receptionist_offers', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role cannot write ai_receptionist_offers';
  END IF;
  -- Permissive policies only: require_mfa_policy's is RESTRICTIVE and is
  -- the one policy this table should have.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'ai_receptionist_offers'
                AND permissive = 'PERMISSIVE') THEN
    RAISE EXCEPTION 'ai_receptionist_offers has a permissive policy; it is service-role only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.ai_receptionist_offers'::regclass
                    AND conname = 'ai_receptionist_offers_one_per_day' AND contype = 'u') THEN
    RAISE EXCEPTION 'one offer per conversation, day and address is not enforced';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.ai_receptionist_offers'::regclass
         AND conname = 'ai_receptionist_offers_one_per_day')) !~ '^UNIQUE \(organization_id' THEN
    RAISE EXCEPTION 'the offer key does not lead with the organization';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'subscriptions'
                    AND column_name = 'booked_via' AND is_nullable = 'YES'
                    AND column_default IS NULL) THEN
    RAISE EXCEPTION 'subscriptions.booked_via is missing, required, or defaulted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'qc_tickets'
                    AND column_name = 'requested_via' AND is_nullable = 'YES'
                    AND column_default IS NULL) THEN
    RAISE EXCEPTION 'qc_tickets.requested_via is missing, required, or defaulted';
  END IF;
END
$check$;
