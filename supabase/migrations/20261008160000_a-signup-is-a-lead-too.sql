-- A signup is a lead too.
--
-- A business had two public forms, /lead/{slug} and /signup/{slug}, and they
-- are now one (/signup/{slug}; the lead address forwards to it). A visitor on
-- it either starts service with a card or asks for a quote, and the owner asked
-- for both to land in the same place: Leads.
--
-- A quote request has always been a `leads` row. A signup was a
-- `signup_requests` row and, once paid, a client, and the office was never
-- shown it as anything: no lead, no notice. Worse, a signup that was priced and
-- then abandoned at the card form, the person most worth a phone call, existed
-- only in a table no screen reads.
--
-- So createSignupPaymentIntent now writes a `leads` row (source
-- 'online_signup', or 'door_signup' from canvassing walk mode) alongside the
-- signup request, and the Stripe webhook marks that lead converted, linked to
-- the client, when it provisions. This column is the link between the two, so
-- the webhook knows which lead to convert and Leads can say how far the signup
-- got ("Started service online", "Started signup online, didn't pay").
--
-- ── REPLAY ────────────────────────────────────────────────────────────────
--
-- One nullable column, its foreign key and its index, all IF NOT EXISTS, on
-- two tables created long before this file. No rows are read or written, so an
-- empty database replays it exactly as production applies it. No new table, so
-- no RLS and no require_mfa_policy; the column is read under the existing
-- "org members read signup_requests" policy and written only by the service
-- role. ON DELETE SET NULL: deleting a lead must not take a paid signup's
-- record with it.

ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS signup_requests_lead_id_idx
  ON public.signup_requests (lead_id);

COMMENT ON COLUMN public.signup_requests.lead_id IS
  'The lead this signup wrote, so it shows in Leads beside quote requests. Set by createSignupPaymentIntent; the Stripe webhook marks the lead converted when it provisions the client.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'signup_requests' AND column_name = 'lead_id'
  ) THEN
    RAISE EXCEPTION 'signup_requests.lead_id was not created';
  END IF;
END
$check$;
