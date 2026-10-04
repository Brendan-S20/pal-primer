-- Nothing in the field told anyone.
--
-- The owner turned push on and a test notification arrived, and then nothing
-- else ever did. Every push leaves through one door, notifyUsers in
-- src/lib/notify-center.server.ts, and every caller of it was an office
-- event. The field -- a skip, a late truck, a finished route, a stop moved
-- onto a tech's day -- notified nobody, and the one field event that did
-- notify, cash or a check a tech took, did it from SQL: record_field_collection
-- inserted app_notifications rows itself, which landed in the notification
-- centre and could never reach a phone, because sending a push is app code.
--
-- Three things, none of them a new table or a new function.
--
-- 1. record_field_collection stops writing notifications. Its caller,
--    recordFieldCollection, now tells the owner and office managers through
--    notifyRoles, the same door every other notification uses, and that door
--    pushes. This is option (a) of the two ways to get a SQL-originated row
--    onto a phone, and it was the only SQL path: a grep of every migration for
--    an INSERT into app_notifications finds this function and nothing else.
--    The alternative, a trigger on app_notifications calling back into the
--    app through pg_net, would have put a network call and a shared secret in
--    the write path for the sake of one caller, and made notifyUsers stop
--    pushing so nothing went twice. The check block below warns if a second
--    SQL writer ever appears.
--
-- 2. app_notifications learns which ITEM a row is about, and which EVENT made
--    it. thread_id is the item ('route:<staffId>:<day>', 'visit:<id>'): the
--    same key the phone groups pushes by, and what a burst of changes to one
--    route is coalesced on, so a dispatcher dragging ten stops is one
--    notification updated in place rather than ten. event_key names the event
--    ('field_collection:<id>', 'late:<visitId>:<step>'), unique per
--    recipient, so the same event told twice -- an offline replay, a GPS ping
--    every thirty seconds while a truck is late -- inserts one row, and only
--    a row that was actually inserted is pushed. Unique on
--    (recipient_user_id, event_key) as a FULL index, not a partial one:
--    PostgREST cannot send a partial index's WHERE clause, so ON CONFLICT
--    could never infer it (see savePushSubscription in push.server.ts for the
--    same lesson). NULLs are distinct, so every row without a key is
--    untouched.
--
-- 3. app_notification_prefs remembers the language the person reads. A tech's
--    push about their own route is written in their language (the rule in
--    CLAUDE.md, "A tech's screen speaks the tech's language"), and until now
--    the language lived only in the phone's localStorage, where the server
--    that writes the push cannot see it. The app writes it here when it
--    starts and whenever it changes. NULL is English.
--
-- Replays into an empty database: two columns and two indexes on a table an
-- earlier migration created, one column on another, and one function
-- replaced. The check block reads no rows.

-- ── 2. The item and the event ──────────────────────────────────────────────

ALTER TABLE public.app_notifications ADD COLUMN IF NOT EXISTS thread_id text;
ALTER TABLE public.app_notifications ADD COLUMN IF NOT EXISTS event_key text;

ALTER TABLE public.app_notifications DROP CONSTRAINT IF EXISTS app_notifications_thread_id_length;
ALTER TABLE public.app_notifications ADD CONSTRAINT app_notifications_thread_id_length
  CHECK (thread_id IS NULL OR char_length(thread_id) BETWEEN 1 AND 200);
ALTER TABLE public.app_notifications DROP CONSTRAINT IF EXISTS app_notifications_event_key_length;
ALTER TABLE public.app_notifications ADD CONSTRAINT app_notifications_event_key_length
  CHECK (event_key IS NULL OR char_length(event_key) BETWEEN 1 AND 200);

COMMENT ON COLUMN public.app_notifications.thread_id IS
  'The item this notification is about, e.g. route:<staffId>:<day> or visit:<id>. The same key the phone groups pushes by (APNs thread-id), and what a burst of route changes is coalesced on.';
COMMENT ON COLUMN public.app_notifications.event_key IS
  'The event that made this row, unique per recipient, so the same event told twice (an offline replay, a GPS ping while a truck is late) inserts one row and pushes once.';

CREATE UNIQUE INDEX IF NOT EXISTS app_notifications_recipient_event_key
  ON public.app_notifications (recipient_user_id, event_key);

CREATE INDEX IF NOT EXISTS app_notifications_recipient_thread
  ON public.app_notifications (recipient_user_id, thread_id, created_at DESC)
  WHERE thread_id IS NOT NULL;

-- ── 3. The language a person reads ─────────────────────────────────────────

ALTER TABLE public.app_notification_prefs ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE public.app_notification_prefs DROP CONSTRAINT IF EXISTS app_notification_prefs_language_check;
ALTER TABLE public.app_notification_prefs ADD CONSTRAINT app_notification_prefs_language_check
  CHECK (language IS NULL OR language IN ('en', 'es', 'ar', 'zh'));

COMMENT ON COLUMN public.app_notification_prefs.language IS
  'The interface language this person reads (lib/i18n), so a push about their own route is written in it. Written by the app on start and on change; NULL is English.';

-- ── 1. The cash a tech took is told by the app, which pushes ───────────────

CREATE OR REPLACE FUNCTION public.record_field_collection(
  _visit_id uuid,
  _amount_cents integer,
  _method text,
  _reference text DEFAULT NULL,
  _client_key uuid DEFAULT NULL,
  _collected_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _v record;
  _staff record;
  _today date;
  _existing uuid;
  _open bigint;
  _waiting bigint;
  _ref text;
  _at timestamptz;
  _id uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to record a collection' USING ERRCODE = '42501';
  END IF;

  SELECT v.id, v.organization_id, v.client_id, v.assigned_staff_id, v.scheduled_on, v.status,
         COALESCE(NULLIF(o.timezone, ''), 'America/Chicago') AS tz
    INTO _v
    FROM public.visits v
    JOIN public.organizations o ON o.id = v.organization_id
   WHERE v.id = _visit_id;

  -- One message for "no such visit" and "not yours", so the function cannot
  -- be used to ask whether a visit id exists in somebody else's business.
  SELECT s.id, s.display_name INTO _staff
    FROM public.staff s
   WHERE _v.id IS NOT NULL
     AND s.id = _v.assigned_staff_id
     AND s.user_id = _uid
     AND s.organization_id = _v.organization_id
     AND s.active;
  IF _staff.id IS NULL OR NOT public.is_org_member(_uid, _v.organization_id) THEN
    RAISE EXCEPTION 'You can only record a collection on a visit assigned to you' USING ERRCODE = '42501';
  END IF;

  IF _v.status = 'canceled' THEN
    RAISE EXCEPTION 'This visit was canceled' USING ERRCODE = '22023';
  END IF;

  -- Today or the last three days of the org's calendar: long enough for a
  -- collection queued in a dead zone on Friday to replay on Monday morning,
  -- short enough that nobody records last month's cash against a visit.
  _today := (now() AT TIME ZONE _v.tz)::date;
  IF _v.scheduled_on > _today OR _v.scheduled_on < _today - 3 THEN
    RAISE EXCEPTION 'A collection can only be recorded on a visit from the last few days' USING ERRCODE = '22023';
  END IF;

  IF _method IS NULL OR _method NOT IN ('cash', 'check') THEN
    RAISE EXCEPTION 'A collection is cash or a check' USING ERRCODE = '22023';
  END IF;
  _ref := CASE WHEN _method = 'check' THEN NULLIF(btrim(COALESCE(_reference, '')), '') END;
  IF _ref IS NOT NULL AND char_length(_ref) > 120 THEN
    RAISE EXCEPTION 'That check number is too long' USING ERRCODE = '22023';
  END IF;
  IF _amount_cents IS NULL OR _amount_cents <= 0 THEN
    RAISE EXCEPTION 'Enter the amount you collected' USING ERRCODE = '22023';
  END IF;

  -- One customer at a time, so two collections recorded at once cannot both
  -- read the same balance and together exceed it.
  PERFORM pg_advisory_xact_lock(hashtextextended('field_collections:' || _v.client_id::text, 0));

  -- A replay of a request that landed: same key, same answer.
  IF _client_key IS NOT NULL THEN
    SELECT fc.id INTO _existing
      FROM public.field_collections fc
     WHERE fc.client_key = _client_key;
    IF _existing IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.field_collections fc
         WHERE fc.id = _existing AND fc.visit_id = _visit_id AND fc.collected_by_staff_id = _staff.id
      ) THEN
        RAISE EXCEPTION 'That collection belongs to a different visit' USING ERRCODE = '42501';
      END IF;
      RETURN _existing;
    END IF;
  END IF;

  -- A double tap, or an older build's replay with no key: the same visit,
  -- amount and method from the same tech within ten minutes is one collection.
  SELECT fc.id INTO _existing
    FROM public.field_collections fc
   WHERE fc.visit_id = _visit_id
     AND fc.collected_by_staff_id = _staff.id
     AND fc.amount_cents = _amount_cents
     AND fc.method = _method
     AND fc.status = 'awaiting_confirmation'
     AND fc.created_at > now() - interval '10 minutes'
   ORDER BY fc.created_at DESC
   LIMIT 1;
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;

  -- No more than the customer owes, less what is already waiting.
  SELECT COALESCE(sum(GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0), 0)), 0)
    INTO _open
    FROM public.invoices i
   WHERE i.client_id = _v.client_id
     AND i.organization_id = _v.organization_id
     AND i.status = 'open';
  SELECT COALESCE(sum(fc.amount_cents), 0) INTO _waiting
    FROM public.field_collections fc
   WHERE fc.client_id = _v.client_id
     AND fc.status = 'awaiting_confirmation';
  IF _amount_cents > _open - _waiting THEN
    RAISE EXCEPTION 'That is more than this customer owes (%)',
      '$' || to_char(GREATEST(_open - _waiting, 0) / 100.0, 'FM999,999,990.00')
      USING ERRCODE = '22023';
  END IF;

  -- The phone's clock is a hint: inside the last seven days and not in the
  -- future, or it is now.
  _at := CASE
    WHEN _collected_at IS NULL OR _collected_at > now() OR _collected_at < now() - interval '7 days'
      THEN now()
    ELSE _collected_at
  END;

  INSERT INTO public.field_collections (
    organization_id, client_id, visit_id, collected_by_staff_id,
    amount_cents, method, reference, collected_at, client_key
  ) VALUES (
    _v.organization_id, _v.client_id, _visit_id, _staff.id,
    _amount_cents, _method, _ref, _at, _client_key
  )
  RETURNING id INTO _id;

  -- Nobody is told HERE any more. The owner and office managers are told by
  -- recordFieldCollection (src/lib/field-collections.functions.ts) through
  -- notifyRoles, which is the only path that also pushes to their phones, and
  -- whose event key ('field_collection:' || this id) makes a replay of this
  -- call -- which returns the same id -- tell nobody twice.

  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_field_collection(uuid, integer, text, text, uuid, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_field_collection(uuid, integer, text, text, uuid, timestamptz)
  TO authenticated, service_role;

-- What this file establishes, from any starting state and with no rows.
DO $check$
DECLARE
  _fn regprocedure := 'public.record_field_collection(uuid, integer, text, text, uuid, timestamptz)'::regprocedure;
  _other text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'app_notifications'
       AND column_name = 'thread_id' AND data_type = 'text'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'app_notifications'
       AND column_name = 'event_key' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'app_notifications is missing thread_id or event_key';
  END IF;

  -- Unique, valid, and NOT partial, or ON CONFLICT from the app cannot use it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.app_notifications'::regclass
       AND c.relname = 'app_notifications_recipient_event_key'
       AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
       AND pg_get_indexdef(i.indexrelid) ILIKE '%(recipient_user_id, event_key)%'
  ) THEN
    RAISE EXCEPTION 'app_notifications has no valid, non-partial unique index on (recipient_user_id, event_key)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'app_notification_prefs'
       AND column_name = 'language' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'app_notification_prefs has no language column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.app_notification_prefs'::regclass
       AND conname = 'app_notification_prefs_language_check'
       AND pg_get_constraintdef(oid) ILIKE '%zh%'
  ) THEN
    RAISE EXCEPTION 'app_notification_prefs.language accepts any string';
  END IF;

  -- Both tables keep their row security: a recipient sees only their own.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.app_notifications'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.app_notification_prefs'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on app_notifications or app_notification_prefs';
  END IF;

  -- The function no longer writes a notification, and is still the tech's
  -- only way in: definer, closed to anon, open to authenticated.
  IF position('app_notifications' IN (SELECT prosrc FROM pg_proc WHERE oid = _fn)) > 0 THEN
    RAISE EXCEPTION 'record_field_collection still writes app_notifications, which can never reach a phone';
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'record_field_collection is executable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'record_field_collection is not executable by authenticated';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = _fn) THEN
    RAISE EXCEPTION 'record_field_collection must be SECURITY DEFINER';
  END IF;

  -- Any OTHER function in public that writes the table: a row it inserts
  -- lands in the notification centre and never on a phone. A warning, not an
  -- exception: this file did not create those functions, and what lives in
  -- public is not the same on every database. prosrc, never
  -- pg_get_functiondef, so no prokind can make this raise.
  FOR _other IN
    SELECT p.oid::regprocedure::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc ~* 'insert\s+into\s+(public\.)?app_notifications'
  LOOP
    RAISE WARNING '% inserts into app_notifications from SQL; those rows never reach a phone. Notify from the server function that calls it (notifyUsers).', _other;
  END LOOP;
END
$check$;
