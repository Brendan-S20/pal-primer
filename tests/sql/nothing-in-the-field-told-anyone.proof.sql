-- Nothing in the field told anyone: what 20261004150000 changes, proved
-- against a real Postgres. Run by
-- tests/a-collection-is-told-by-the-app-that-pushes.test.ts, which passes
--   :methods    20260928030000 (payments learned a method; a local stack can
--               predate it, and it is idempotent),
--   :cash       20261002150000 (field_collections and record_field_collection
--               as they were, INSERT into app_notifications and all),
--   :migration  20261004150000, the file under proof.
--
-- One transaction, ROLLED BACK at the end, migrations included, so this can
-- be pointed at a shared local stack without leaving anything behind. Each
-- group prints "ok: ..." only when every check in it passed, or raises
-- "PROOF FAILED [...]"; ON_ERROR_STOP makes the first failure the exit code.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :methods
\i :cash

-- ── Before: the function wrote the notification itself ─────────────────────
-- Proved first, so the "after" below is a change and not a fixture that never
-- notified anyone in the first place.

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a3000000-0000-4000-8000-00000000a001', 'olivia@field.proof.invalid'),
  ('a3000000-0000-4000-8000-00000000a002', 'max@field.proof.invalid'),
  ('a3000000-0000-4000-8000-00000000a005', 'sam@field.proof.invalid'),
  ('a3000000-0000-4000-8000-00000000a006', 'priya@field.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a300000-0000-4000-8000-0000000000aa', 'Field Proof A', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a3000000-0000-4000-8000-00000000a001', '0a300000-0000-4000-8000-0000000000aa', 'owner'),
  ('a3000000-0000-4000-8000-00000000a002', '0a300000-0000-4000-8000-0000000000aa', 'office_manager'),
  ('a3000000-0000-4000-8000-00000000a005', '0a300000-0000-4000-8000-0000000000aa', 'tech'),
  ('a3000000-0000-4000-8000-00000000a006', '0a300000-0000-4000-8000-0000000000aa', 'tech');
INSERT INTO public.staff (id, organization_id, user_id, role, display_name) VALUES
  ('5e000000-0000-4000-8000-000000000005', '0a300000-0000-4000-8000-0000000000aa',
   'a3000000-0000-4000-8000-00000000a005', 'tech', 'Sam Rivera');
INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c3000000-0000-4000-8000-0000000000a1', '0a300000-0000-4000-8000-0000000000aa', 'residential', 'Field Customer');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('e3000000-0000-4000-8000-0000000000a1', '0a300000-0000-4000-8000-0000000000aa',
   'c3000000-0000-4000-8000-0000000000a1', '12 Elm St', 'Chicago', '60614');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count) VALUES
  ('d3000000-0000-4000-8000-0000000000a1', '0a300000-0000-4000-8000-0000000000aa',
   'c3000000-0000-4000-8000-0000000000a1', 'e3000000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2500, 1),
  ('d3000000-0000-4000-8000-0000000000a2', '0a300000-0000-4000-8000-0000000000aa',
   'c3000000-0000-4000-8000-0000000000a1', 'e3000000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2500, 1);
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, assigned_staff_id, scheduled_on, status)
SELECT x.id::uuid, '0a300000-0000-4000-8000-0000000000aa', x.sub::uuid, 'c3000000-0000-4000-8000-0000000000a1',
       'e3000000-0000-4000-8000-0000000000a1', '5e000000-0000-4000-8000-000000000005',
       (now() AT TIME ZONE 'America/Chicago')::date, 'scheduled'
  FROM (VALUES
    ('f3000000-0000-4000-8000-0000000000a1', 'd3000000-0000-4000-8000-0000000000a1'),
    ('f3000000-0000-4000-8000-0000000000a2', 'd3000000-0000-4000-8000-0000000000a2')
  ) AS x(id, sub);
INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status) VALUES
  ('13000000-0000-4000-8000-0000000000a1', '0a300000-0000-4000-8000-0000000000aa',
   'c3000000-0000-4000-8000-0000000000a1', current_date - 2, 10000, 'open');
SET LOCAL app.allow_protected_org_write = '';

SELECT set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-00000000a005","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.record_field_collection('f3000000-0000-4000-8000-0000000000a1', 1000, 'cash');
END $$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.app_notifications
       WHERE organization_id = '0a300000-0000-4000-8000-0000000000aa' AND type = 'field_collection') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [before]: the old function did not notify the owner and the office manager, so "after" proves nothing';
  END IF;
  DELETE FROM public.app_notifications WHERE organization_id = '0a300000-0000-4000-8000-0000000000aa';
  RAISE NOTICE 'ok: before the migration, record_field_collection wrote the notification rows itself';
END $$;

-- ── The migration ───────────────────────────────────────────────────────────

\i :migration

-- ── After: the collection is recorded, and nobody is told from SQL ─────────

SELECT set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-00000000a005","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _id uuid; _again uuid;
BEGIN
  _id := public.record_field_collection('f3000000-0000-4000-8000-0000000000a2', 1500, 'check', '1042',
                                        '99300000-0000-4000-8000-000000000001');
  IF _id IS NULL OR NOT EXISTS (SELECT 1 FROM public.field_collections WHERE id = _id AND amount_cents = 1500) THEN
    RAISE EXCEPTION 'PROOF FAILED [record]: the collection was not recorded';
  END IF;
  -- The replay the offline queue sends: same key, same id. The app keys its
  -- notification on this id, so a second answer that differed would be a
  -- second notification.
  _again := public.record_field_collection('f3000000-0000-4000-8000-0000000000a2', 1500, 'check', '1042',
                                           '99300000-0000-4000-8000-000000000001');
  IF _again IS DISTINCT FROM _id THEN
    RAISE EXCEPTION 'PROOF FAILED [replay]: a replay came back as % not %', _again, _id;
  END IF;
  -- Still refused on a visit that is not his: the rules came through the copy.
  BEGIN
    PERFORM public.record_field_collection('f3000000-0000-4000-8000-0000000000ff', 100, 'cash');
    RAISE EXCEPTION 'PROOF FAILED [refuse]: recorded on a visit that does not exist';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.record_field_collection('f3000000-0000-4000-8000-0000000000a2', 9000000, 'cash');
    RAISE EXCEPTION 'PROOF FAILED [refuse]: recorded more than the customer owes';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $$;
RESET ROLE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_notifications WHERE organization_id = '0a300000-0000-4000-8000-0000000000aa') THEN
    RAISE EXCEPTION 'PROOF FAILED [after]: record_field_collection still writes app_notifications';
  END IF;
  IF has_function_privilege('anon', 'public.record_field_collection(uuid, integer, text, text, uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: anon can record a collection';
  END IF;
  RAISE NOTICE 'ok: after it, the collection is recorded and replayed the same, the rules still refuse, and no row is written from SQL';
END $$;

-- ── An event is told once per recipient; rows without a key are untouched ──

DO $$
DECLARE _n int; _err text;
BEGIN
  INSERT INTO public.app_notifications (organization_id, recipient_user_id, type, title, thread_id, event_key) VALUES
    ('0a300000-0000-4000-8000-0000000000aa', 'a3000000-0000-4000-8000-00000000a001', 'visit_late', 'late', 'route:s:d', 'late:v1:0'),
    ('0a300000-0000-4000-8000-0000000000aa', 'a3000000-0000-4000-8000-00000000a002', 'visit_late', 'late', 'route:s:d', 'late:v1:0'),
    ('0a300000-0000-4000-8000-0000000000aa', 'a3000000-0000-4000-8000-00000000a001', 'concern', 'a', NULL, NULL),
    ('0a300000-0000-4000-8000-0000000000aa', 'a3000000-0000-4000-8000-00000000a001', 'concern', 'b', NULL, NULL);
  -- What the app sends: ON CONFLICT on exactly these two columns, which only
  -- a non-partial unique index can answer.
  INSERT INTO public.app_notifications (organization_id, recipient_user_id, type, title, event_key)
  VALUES ('0a300000-0000-4000-8000-0000000000aa', 'a3000000-0000-4000-8000-00000000a001', 'visit_late', 'again', 'late:v1:0')
  ON CONFLICT (recipient_user_id, event_key) DO NOTHING;
  SELECT count(*) INTO _n FROM public.app_notifications WHERE event_key = 'late:v1:0';
  IF _n <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [event key]: % rows for one event and two recipients', _n;
  END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.app_notifications (organization_id, recipient_user_id, type, title, event_key)
    VALUES ('0a300000-0000-4000-8000-0000000000aa', 'a3000000-0000-4000-8000-00000000a002', 'visit_late', 'dup', 'late:v1:0');
  EXCEPTION WHEN unique_violation THEN _err := 'refused';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [event key]: the same event was told twice to one person'; END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.app_notifications (organization_id, recipient_user_id, type, title, thread_id)
    VALUES ('0a300000-0000-4000-8000-0000000000aa', 'a3000000-0000-4000-8000-00000000a002', 'x', 'x', repeat('t', 201));
  EXCEPTION WHEN check_violation THEN _err := 'refused';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [thread]: a 201-character thread id was stored'; END IF;
  RAISE NOTICE 'ok: one event is one row per recipient, any number of keyless rows coexist, and a thread id is bounded';
END $$;

-- A recipient still reads only their own, thread and key included.
SELECT set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.app_notifications;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [own rows]: the office manager reads % rows, expected his one', _n; END IF;
  RAISE NOTICE 'ok: a person reads only their own notifications';
END $$;
RESET ROLE;

-- ── The language a person reads ────────────────────────────────────────────

SELECT set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-00000000a005","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _err text; _lang text; _muted text[];
BEGIN
  -- What setMyNotificationLanguage sends, on the tech's own session.
  INSERT INTO public.app_notification_prefs (user_id, language)
  VALUES ('a3000000-0000-4000-8000-00000000a005', 'es')
  ON CONFLICT (user_id) DO UPDATE SET language = EXCLUDED.language;
  INSERT INTO public.app_notification_prefs (user_id, muted_types)
  VALUES ('a3000000-0000-4000-8000-00000000a005', ARRAY['route_changed'])
  ON CONFLICT (user_id) DO UPDATE SET muted_types = EXCLUDED.muted_types;
  SELECT language, muted_types INTO _lang, _muted FROM public.app_notification_prefs
   WHERE user_id = 'a3000000-0000-4000-8000-00000000a005';
  IF _lang IS DISTINCT FROM 'es' OR _muted IS DISTINCT FROM ARRAY['route_changed'] THEN
    RAISE EXCEPTION 'PROOF FAILED [language]: stored % / %; setting one must not clear the other', _lang, _muted;
  END IF;
  _err := NULL;
  BEGIN
    UPDATE public.app_notification_prefs SET language = 'fr' WHERE user_id = 'a3000000-0000-4000-8000-00000000a005';
  EXCEPTION WHEN check_violation THEN _err := 'refused';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [language]: a language the app has no words for was stored'; END IF;
  -- And nobody else's.
  _err := NULL;
  BEGIN
    INSERT INTO public.app_notification_prefs (user_id, language)
    VALUES ('a3000000-0000-4000-8000-00000000a006', 'zh');
  EXCEPTION WHEN insufficient_privilege THEN _err := 'refused';
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [language]: Sam set Priya''s language'; END IF;
  RAISE NOTICE 'ok: a person sets their own language, keeps their mutes, and cannot set someone else''s';
END $$;
RESET ROLE;

ROLLBACK;

\echo ALL FIELD NOTIFICATION PROOFS PASSED
