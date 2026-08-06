-- Changing a customer's service day saved, and then nothing moved.
--
-- `generate_visits_core` picks the next date like this:
--
--   SELECT MAX(scheduled_on) INTO _next FROM visits WHERE subscription_id = ...;
--   IF _next IS NULL THEN
--     _candidate := _sub.started_on;
--     IF _prefs IS NOT NULL AND frequency IN ('weekly','biweekly') THEN
--       ... advance to a preferred weekday ...
--     END IF;
--   ELSE
--     _candidate := _next + _step;          <-- preferences never consulted
--   END IF;
--
-- So `preferred_weekdays` is honoured exactly once: on the very first visit a
-- subscription ever generates. From then on the series chains off its own last
-- date, which preserves whatever weekday it started on. Edit a client from
-- Monday to Thursday and the form saves, the column updates, and every future
-- visit still lands on Monday. Forever. No error, no warning — the setting
-- simply has no reader after the first run.
--
-- Found on the demo org: five subscriptions carrying preferred_weekdays = {1}
-- (Monday) were generating Sunday visits, because they had originally been
-- created on a Sunday and the preference was changed afterwards.
--
-- ── THE FIX ───────────────────────────────────────────────────────────────
--
-- After stepping forward, snap the candidate onto a preferred weekday if it is
-- not already on one. Forward only, never backward — moving back could land
-- before `_next` and collide with a visit that already exists.
--
-- The transition costs one longer-than-usual gap: a weekly route moved from
-- Monday to Thursday waits 10 days once, then settles at 7. That is the
-- correct behaviour and the same thing a human dispatcher would do; the
-- alternative — skipping a cycle to land sooner — would drop a service the
-- customer is paying for.
--
-- Applies to weekly and biweekly only, matching the branch above it.
-- `twice_weekly` has its own explicit day-array loop and already honours
-- preferences on every pass. `monthly`, `one_time` and `every_n_days` are
-- interval-driven and have no weekday preference to respect.
--
-- ── WHY THIS PATCHES THE LIVE DEFINITION ─────────────────────────────────
--
-- Spliced into pg_get_functiondef() rather than restated. The body carries the
-- blackout-date skip, the client-hold skip, the work-days fallback and the
-- twice-weekly branch; retyping ~120 lines to insert four is how one of those
-- quietly disappears. The splice asserts its anchor appears exactly once and
-- aborts otherwise.

DO $mig$
DECLARE _def text; _n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_visits_core';

  IF _def IS NULL THEN RAISE EXCEPTION 'generate_visits_core not found'; END IF;

  IF position('snap onto a preferred weekday' in _def) > 0 THEN
    RAISE NOTICE 'generate_visits_core already honours preferences on later runs';
    RETURN;
  END IF;

  _n := (length(_def) - length(replace(_def, '_candidate := _next + _step;', '')))
        / length('_candidate := _next + _step;');
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 chained-step assignment, found %', _n;
  END IF;

  _def := replace(
    _def,
    '_candidate := _next + _step;',
    '_candidate := _next + _step;
        -- snap onto a preferred weekday. Without this the series keeps the
        -- weekday it was created with and preferred_weekdays is write-only
        -- after the first generated visit.
        IF _prefs IS NOT NULL AND _sub.frequency IN (''weekly'',''biweekly'') THEN
          _guard := 0;
          WHILE NOT (EXTRACT(DOW FROM _candidate)::int = ANY(_prefs)) AND _guard < 7 LOOP
            _candidate := _candidate + 1;
            _guard := _guard + 1;
          END LOOP;
        END IF;'
  );

  EXECUTE _def;
END
$mig$;

COMMENT ON FUNCTION public.generate_visits_core(uuid, date, uuid) IS
  'Generates visits from active subscriptions. preferred_weekdays is honoured '
  'on every run, not only the first: before this it was consulted only when a '
  'subscription had no visits yet, so changing a client''s service day saved '
  'to the column and never moved the schedule.';
