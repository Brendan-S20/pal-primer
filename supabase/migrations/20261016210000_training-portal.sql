-- Training in the customer portal: the client of a business that runs
-- training sees their packages, lesson notes and homework, buys a package,
-- and asks for the next lesson from the balance. Follows 20261016180000 and
-- 20261016200000.
--
-- 1. organizations.training_share_progress (default true). Whether the
--    portal shows a lesson's note and homework to the client. Scores, dates
--    and the session balance show either way. Set through
--    set_training_share_progress, the same two roles as the session rules.
--
-- 2. organizations.notify_email_training_package (default true). The email
--    switch for the two package notices below, beside the other
--    notify_email_* switches in Settings, Emails.
--
-- 3. A lesson request is a qc_tickets row with category
--    'training_lesson_request', in the inbox the office already works
--    (/concerns), carrying the package (client_package_id), the address
--    (property_id), the day (requested_on) and an optional start time
--    (requested_time). service_id is the package's training service, so the
--    portal's "Your requests" names it the way it names a walk.
--    One open request per package per day, held by a partial unique index.
--
-- 4. portal_request_training_lesson, granted like portal_request_one_off:
--    service_role only, reached through a server function after the portal
--    session check. It refuses a package that is not this client's, a
--    canceled or expired one, one with no session left once lessons held and
--    requests still open are counted, a day that is not after today or is
--    after the package expires, and an address that is not the client's.
--    There is no pay-first setting yet, so an unpaid package is not refused
--    here; the office sees the invoice when it books.
--
-- 5. training_package_notices: the ledger that makes the one-session-left
--    and expiring-soon notices send once. The app claims a key here before
--    it emails the client and tells the office. Service role only.
--
-- Replays into an empty database: columns, a constraint, indexes, a table,
-- two functions and their grants. The check block asserts only what this
-- file creates.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS training_share_progress boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_email_training_package boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organizations.training_share_progress IS
  'Whether the customer portal shows a training lesson''s note and homework to the client.';
COMMENT ON COLUMN public.organizations.notify_email_training_package IS
  'Email the client when one session is left on a training package and 14 days before it expires.';

-- ── Lesson requests in the office inbox ──────────────────────────────────

ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS client_package_id uuid;
ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS requested_time time;
ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_client_package_id_fkey;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_client_package_id_fkey
  FOREIGN KEY (client_package_id) REFERENCES public.client_packages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS qc_tickets_client_package_idx ON public.qc_tickets (client_package_id)
  WHERE client_package_id IS NOT NULL;

COMMENT ON COLUMN public.qc_tickets.client_package_id IS
  'For a training_lesson_request: the package the lesson comes out of.';
COMMENT ON COLUMN public.qc_tickets.requested_time IS
  'For a training_lesson_request: the start time the client asked for, when they gave one.';

ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_category_check;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_category_check
  CHECK (category IN ('missed_spot','gate_left_open','damage','wrong_yard','other',
    'reclean_request','one_off_request','training_lesson_request'));
ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_lesson_request_has_a_day;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_lesson_request_has_a_day
  CHECK (category <> 'training_lesson_request' OR requested_on IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS qc_tickets_one_open_lesson_request_per_package_day
  ON public.qc_tickets (client_package_id, requested_on)
  WHERE category = 'training_lesson_request' AND status <> 'resolved';

CREATE OR REPLACE FUNCTION public.portal_request_training_lesson(
  _token uuid, _client_package_id uuid, _property_id uuid, _on date, _at time, _message text
)
RETURNS TABLE (ticket_id uuid, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  _client_id uuid;
  _org_id uuid;
  _p public.client_packages%ROWTYPE;
  _today date;
  _held integer;
  _open integer;
  _id uuid;
BEGIN
  SELECT c.id, c.organization_id INTO _client_id, _org_id
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _client_id IS NULL THEN RAISE EXCEPTION 'invalid_token'; END IF;

  -- Another client's package and a package that does not exist are the same
  -- refusal, so the answer says nothing about packages that are not theirs.
  -- Locked so two taps on two devices count the same balance one at a time.
  SELECT * INTO _p FROM public.client_packages p
   WHERE p.id = _client_package_id AND p.client_id = _client_id AND p.organization_id = _org_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'package_not_found'; END IF;

  PERFORM 1 FROM public.properties p
    WHERE p.id = _property_id AND p.client_id = _client_id
      AND p.organization_id = _org_id AND p.archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'property_not_found'; END IF;

  SELECT (now() AT TIME ZONE COALESCE(NULLIF(o.timezone, ''), 'America/Chicago'))::date INTO _today
    FROM public.organizations o WHERE o.id = _org_id;

  IF _p.status = 'canceled' THEN RAISE EXCEPTION 'package_canceled'; END IF;
  IF _p.expires_on IS NOT NULL AND _today > _p.expires_on THEN RAISE EXCEPTION 'package_expired'; END IF;
  IF _on IS NULL OR _on <= _today THEN RAISE EXCEPTION 'date_too_soon'; END IF;
  IF _p.expires_on IS NOT NULL AND _on > _p.expires_on THEN RAISE EXCEPTION 'after_expiry'; END IF;
  IF _on > _today + 90 THEN RAISE EXCEPTION 'date_too_far'; END IF;

  -- Asked already for this day: hand back that request.
  SELECT t.id INTO _id FROM public.qc_tickets t
   WHERE t.category = 'training_lesson_request' AND t.client_package_id = _p.id
     AND t.requested_on = _on AND t.status <> 'resolved'
   LIMIT 1;
  IF _id IS NOT NULL THEN
    RETURN QUERY SELECT _id, false;
    RETURN;
  END IF;

  -- Lessons booked or used, and requests the office has not answered yet,
  -- both take a session from the balance.
  SELECT count(*) INTO _held FROM public.visits v
   WHERE v.client_package_id = _p.id
     AND public.training_visit_holds_session(v.status, v.skip_billable);
  SELECT count(*) INTO _open FROM public.qc_tickets t
   WHERE t.category = 'training_lesson_request' AND t.client_package_id = _p.id
     AND t.status <> 'resolved' AND t.booked_visit_id IS NULL;
  IF _held + _open >= _p.sessions_count THEN RAISE EXCEPTION 'no_sessions_left'; END IF;

  INSERT INTO public.qc_tickets (organization_id, client_id, property_id, category,
    requested_on, requested_time, message, service_id, client_package_id)
  VALUES (_org_id, _client_id, _property_id, 'training_lesson_request', _on, _at,
    left(NULLIF(btrim(COALESCE(_message, '')), ''), 1000), _p.service_id, _p.id)
  ON CONFLICT (client_package_id, requested_on)
    WHERE category = 'training_lesson_request' AND status <> 'resolved'
  DO NOTHING
  RETURNING id INTO _id;

  IF _id IS NOT NULL THEN
    RETURN QUERY SELECT _id, true;
    RETURN;
  END IF;
  SELECT t.id INTO _id FROM public.qc_tickets t
   WHERE t.category = 'training_lesson_request' AND t.client_package_id = _p.id
     AND t.requested_on = _on AND t.status <> 'resolved'
   LIMIT 1;
  RETURN QUERY SELECT _id, false;
END $function$;

REVOKE ALL ON FUNCTION public.portal_request_training_lesson(uuid, uuid, uuid, date, time, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_request_training_lesson(uuid, uuid, uuid, date, time, text)
  TO service_role;

-- ── The business setting ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_training_share_progress(_org_id uuid, _share boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (
    public.has_role((select auth.uid()), _org_id, 'owner')
    OR public.has_role((select auth.uid()), _org_id, 'office_manager')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Not authorized to update training settings';
  END IF;
  IF _share IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose whether clients see lesson notes and homework.';
  END IF;
  UPDATE public.organizations SET training_share_progress = _share WHERE id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_training_share_progress(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_training_share_progress(uuid, boolean) TO authenticated, service_role;

-- ── Notices that send once ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.training_package_notices (
  dedupe_key text PRIMARY KEY CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_package_id uuid NOT NULL REFERENCES public.client_packages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('one_left', 'expiring')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS training_package_notices_organization_idx
  ON public.training_package_notices (organization_id);
CREATE INDEX IF NOT EXISTS training_package_notices_package_idx
  ON public.training_package_notices (client_package_id);
ALTER TABLE public.training_package_notices ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.training_package_notices');
-- No permissive policy: nobody with a JWT reads or writes it. The nightly job
-- and the lesson paths reach it as service_role.
REVOKE ALL ON TABLE public.training_package_notices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.training_package_notices TO service_role;

DO $check$
DECLARE _def text; _fn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'organizations' AND column_name = 'training_share_progress'
       AND is_nullable = 'NO' AND column_default = 'true')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'organizations' AND column_name = 'notify_email_training_package'
       AND is_nullable = 'NO' AND column_default = 'true') THEN
    RAISE EXCEPTION 'Training portal settings are missing, nullable, or not on by default.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'qc_tickets' AND column_name = 'client_package_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'qc_tickets' AND column_name = 'requested_time') THEN
    RAISE EXCEPTION 'qc_tickets lesson request columns are missing.';
  END IF;

  _def := pg_get_constraintdef((SELECT oid FROM pg_constraint
            WHERE conrelid = 'public.qc_tickets'::regclass AND conname = 'qc_tickets_category_check'));
  IF _def !~ 'training_lesson_request' THEN
    RAISE EXCEPTION 'qc_tickets does not accept training_lesson_request';
  END IF;
  IF _def !~ 'missed_spot.*gate_left_open.*damage.*wrong_yard.*other.*reclean_request.*one_off_request' THEN
    RAISE EXCEPTION 'qc_tickets_category_check dropped an existing category';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
       AND indexname = 'qc_tickets_one_open_lesson_request_per_package_day') THEN
    RAISE EXCEPTION 'The one-open-request-per-package-day index is missing.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'training_package_notices' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'training_package_notices or its RLS is missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
       AND tablename = 'training_package_notices' AND permissive = 'RESTRICTIVE') THEN
    RAISE EXCEPTION 'Training MFA policy is missing: training_package_notices';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
       AND tablename = 'training_package_notices' AND permissive = 'PERMISSIVE') THEN
    RAISE EXCEPTION 'training_package_notices is meant for the service role only.';
  END IF;
  IF has_table_privilege('authenticated', 'public.training_package_notices', 'SELECT')
     OR has_table_privilege('anon', 'public.training_package_notices', 'SELECT') THEN
    RAISE EXCEPTION 'training_package_notices is readable with a client key.';
  END IF;

  _fn := 'public.portal_request_training_lesson(uuid, uuid, uuid, date, time, text)';
  IF has_function_privilege('anon', _fn, 'EXECUTE')
     OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is callable with a client key; the portal reaches it as service_role.', _fn;
  END IF;
  IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is not callable by the portal server.', _fn;
  END IF;
  _fn := 'public.set_training_share_progress(uuid, boolean)';
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is executable with the publishable key', _fn;
  END IF;
  IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is not callable by a signed-in office user', _fn;
  END IF;
END
$check$;
