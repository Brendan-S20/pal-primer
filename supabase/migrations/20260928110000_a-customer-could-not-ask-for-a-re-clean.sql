-- A customer could not ask for a re-clean.
--
-- Found 2026-09-27 by the market research pass. Pet-waste operators advertise
-- a "24-hour re-clean guarantee" (48 and 72 are common too): if a spot was
-- missed, we come back free. No competitor lets the CUSTOMER start that
-- request. Here the customer could only "report a concern", which lands in
-- the same inbox as a gate left open and leaves the office to decide, by
-- hand, whether the guarantee applies and then to book a free visit with no
-- link back to the complaint.
--
-- 1. organizations.reclean_window_hours: how long after a visit is COMPLETED
--    the customer may ask. 0 turns the guarantee off and the portal offers
--    nothing. Capped at a week, because a guarantee that runs longer than
--    the gap between two weekly visits is a second visit, not a re-clean.
--
-- 2. qc_tickets accepts category 'reclean_request', and carries
--    reclean_visit_id: the free return visit once the office books it, so
--    the inbox can say "Re-clean booked for Tuesday" instead of the office
--    remembering.
--
-- 3. portal_request_reclean(_token, _visit_id, _message), modelled on
--    portal_report_concern: the client is resolved from the portal token the
--    same way, and the grants are the same (service_role only; the portal
--    calls it through a server function after the session check). It refuses
--    a visit that is not the client's, not completed, completed outside the
--    window, or the free re-clean visit itself. A second request for the same
--    visit while the first is unresolved returns the first ticket's id: a
--    customer tapping twice, or on two devices, gets one ticket.
--    The idempotency is held by a partial unique index, not only by a SELECT
--    before the INSERT, so two concurrent taps cannot both insert.
--
-- Replays into an empty database: one column, one constraint swap, one
-- column plus index, one function, grants. The DO block at the end asserts
-- only what this file creates; it needs no tenant and no rows.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS reclean_window_hours smallint NOT NULL DEFAULT 48;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_reclean_window_hours_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_reclean_window_hours_check
  CHECK (reclean_window_hours BETWEEN 0 AND 168);

COMMENT ON COLUMN public.organizations.reclean_window_hours IS
  'Re-clean guarantee: hours after a visit is completed during which the customer can ask for a free re-clean from the portal. 0 turns it off.';

-- Same five categories as before, plus the new one.
ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_category_check;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_category_check
  CHECK (category IN ('missed_spot','gate_left_open','damage','wrong_yard','other','reclean_request'));

ALTER TABLE public.qc_tickets
  ADD COLUMN IF NOT EXISTS reclean_visit_id uuid;

ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_reclean_visit_id_fkey;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_reclean_visit_id_fkey
  FOREIGN KEY (reclean_visit_id) REFERENCES public.visits(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS qc_tickets_reclean_visit_idx
  ON public.qc_tickets (reclean_visit_id);

-- One unresolved re-clean request per visit. Resolved ones do not count, so
-- a request the office closed does not block a later one inside the window.
CREATE UNIQUE INDEX IF NOT EXISTS qc_tickets_one_open_reclean_per_visit
  ON public.qc_tickets (visit_id)
  WHERE category = 'reclean_request' AND status <> 'resolved';

COMMENT ON COLUMN public.qc_tickets.reclean_visit_id IS
  'For a reclean_request: the free return visit the office booked for it.';

CREATE OR REPLACE FUNCTION public.portal_request_reclean(_token uuid, _visit_id uuid, _message text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _client_id uuid;
  _org_id uuid;
  _window smallint;
  _status public.visit_status;
  _completed_at timestamptz;
  _ticket_id uuid;
BEGIN
  SELECT id, organization_id INTO _client_id, _org_id
    FROM public.clients WHERE portal_token = _token AND active = true;
  IF _client_id IS NULL THEN RAISE EXCEPTION 'invalid_token'; END IF;

  SELECT reclean_window_hours INTO _window FROM public.organizations WHERE id = _org_id;
  IF COALESCE(_window, 0) = 0 THEN RAISE EXCEPTION 'reclean_off'; END IF;

  SELECT status, completed_at INTO _status, _completed_at
    FROM public.visits WHERE id = _visit_id AND client_id = _client_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'visit_not_found'; END IF;
  IF _status <> 'completed' THEN RAISE EXCEPTION 'visit_not_completed'; END IF;

  -- The window is measured from when the visit was finished, not the day it
  -- was scheduled: a Monday visit completed at 6 PM has until 6 PM Wednesday
  -- on a 48-hour guarantee. No completion time means nothing to measure from.
  IF _completed_at IS NULL OR _completed_at < now() - make_interval(hours => _window) THEN
    RAISE EXCEPTION 'reclean_window_closed';
  END IF;

  -- The guarantee covers the paid visit, not the free return. Without this a
  -- re-clean could be requested of the re-clean, indefinitely.
  PERFORM 1 FROM public.qc_tickets
    WHERE reclean_visit_id = _visit_id AND organization_id = _org_id;
  IF FOUND THEN RAISE EXCEPTION 'visit_is_a_reclean'; END IF;

  INSERT INTO public.qc_tickets(organization_id, client_id, visit_id, category, message)
    VALUES(_org_id, _client_id, _visit_id, 'reclean_request',
           left(NULLIF(btrim(COALESCE(_message, '')), ''), 1000))
  ON CONFLICT (visit_id) WHERE category = 'reclean_request' AND status <> 'resolved'
  DO NOTHING
  RETURNING id INTO _ticket_id;

  IF _ticket_id IS NULL THEN
    -- Already asked: hand back the open request rather than a second one.
    SELECT id INTO _ticket_id FROM public.qc_tickets
     WHERE visit_id = _visit_id AND category = 'reclean_request' AND status <> 'resolved'
     LIMIT 1;
  END IF;
  RETURN _ticket_id;
END $function$;

-- Mirrors portal_report_concern exactly: postgres and service_role, nobody
-- else. The default privileges on public hand new functions to authenticated
-- too, so that grant is taken back here as well.
REVOKE ALL ON FUNCTION public.portal_request_reclean(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_request_reclean(uuid, uuid, text) TO service_role;

-- What this file establishes.
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'reclean_window_hours' AND is_nullable = 'NO'
       AND column_default = '48'
  ) THEN
    RAISE EXCEPTION 'organizations.reclean_window_hours is missing, nullable, or not defaulted to 48';
  END IF;

  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.organizations'::regclass
         AND conname = 'organizations_reclean_window_hours_check')) !~ '168' THEN
    RAISE EXCEPTION 'reclean_window_hours is not capped at 168';
  END IF;

  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.qc_tickets'::regclass
         AND conname = 'qc_tickets_category_check')) !~ 'reclean_request' THEN
    RAISE EXCEPTION 'qc_tickets does not accept reclean_request';
  END IF;
  -- The swap must not have lost the categories that were already there.
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.qc_tickets'::regclass
         AND conname = 'qc_tickets_category_check')) !~ 'missed_spot.*gate_left_open.*damage.*wrong_yard.*other' THEN
    RAISE EXCEPTION 'qc_tickets_category_check dropped an existing category';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.qc_tickets'::regclass
       AND conname = 'qc_tickets_reclean_visit_id_fkey'
       AND confrelid = 'public.visits'::regclass
       AND confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION 'qc_tickets.reclean_visit_id does not reference visits ON DELETE SET NULL';
  END IF;

  IF to_regclass('public.qc_tickets_reclean_visit_idx') IS NULL THEN
    RAISE EXCEPTION 'qc_tickets.reclean_visit_id is not indexed';
  END IF;
  IF NOT (SELECT indisunique FROM pg_index
            WHERE indexrelid = 'public.qc_tickets_one_open_reclean_per_visit'::regclass) THEN
    RAISE EXCEPTION 'one open re-clean per visit is not enforced';
  END IF;

  IF (SELECT prosecdef FROM pg_proc
       WHERE oid = 'public.portal_request_reclean(uuid, uuid, text)'::regprocedure) IS NOT TRUE THEN
    RAISE EXCEPTION 'portal_request_reclean is not SECURITY DEFINER';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.portal_request_reclean(uuid, uuid, text)'::regprocedure)
       !~ 'reclean_window_hours' THEN
    RAISE EXCEPTION 'portal_request_reclean does not read the organization''s window';
  END IF;

  IF has_function_privilege('anon', 'public.portal_request_reclean(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute portal_request_reclean';
  END IF;
  IF has_function_privilege('authenticated', 'public.portal_request_reclean(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute portal_request_reclean; the portal reaches it only through service_role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.portal_request_reclean(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute portal_request_reclean';
  END IF;
END
$check$;
