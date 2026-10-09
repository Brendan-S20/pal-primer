-- The lock screen starts the stop.
--
-- Until now the Start and Complete buttons on the route's Live Activity only
-- OPENED the app on the stop (20261004120000, #351). The owner, after the
-- 2026-10-08 TestFlight build: Start should start, from the lock screen,
-- without unlocking the phone and finding the button again.
--
-- iOS runs a lock-screen button's App Intent in the app's process, in the
-- background, with no web view and no JavaScript, so it cannot call the
-- startVisit server function the way My Day does: that needs the tech's
-- Supabase session, and a session is exactly what must never be written
-- into a Live Activity or left where an intent can read it. So the intent
-- carries something much narrower, an ACTION TOKEN:
--
--   * minted by the app, while signed in, when the route goes on the lock
--     screen (src/lib/live-activity.functions.ts mintLiveActivityActionToken);
--   * good for ONE technician, in ONE organization, for ONE route day, and
--     for nothing but starting a stop on that route;
--   * short-lived: it expires at the end of the org's workday plus grace, and
--     never later than sixteen hours after it was minted;
--   * revoked when the activity ends, on clock-out, and whenever a newer one
--     is minted for the same person;
--   * stored here only as its SHA-256. The token itself lives in the iPhone's
--     keychain and nowhere else.
--
-- The hook that accepts it (src/routes/api/public/hooks/live-activity-
-- action.ts) runs as the service role. To do the SAME transition the app
-- does, rather than a second copy of it, the body of start_visit moves into
-- start_visit_as(_actor, ...), which takes the actor explicitly, and
-- start_visit becomes a one-line call to it with auth.uid(). The
-- authorization inside is unchanged: is_visit_tech(_actor, _visit_id), the
-- primitive it has always used. start_visit_as is service_role only; nothing
-- a browser holds can call it, and a NULL actor is refused.
--
-- Complete is NOT done this way, deliberately. A completion fans out to the
-- customer's email, a push to the portal and an automatic review text, and
-- two of the gates on that path read the tech's own session
-- (mark_review_asked checks can_write_org(auth.uid()), client_may_be_texted
-- is granted to authenticated). Run as the service role they would refuse,
-- or need a second copy of the rules. So the lock screen's Complete keeps
-- opening the app, now straight into the stop's photo capture when a photo
-- is what the visit needs.
--
-- live_activity_actions is the audit trail and the idempotency key: one row
-- per (token, visit, action), so a double tap on the lock screen starts the
-- stop once, and every attempt that got as far as the stop says who, what
-- and when.
--
-- Both tables are service-role only. RLS is enabled with no permissive
-- policy, plus the two-step sign-in policy every RLS table carries, so a
-- browser key reads and writes nothing in them.
--
-- Replays into an empty database: two tables, their indexes, two functions,
-- grants. The check block asserts what this file establishes and needs no
-- row.

-- ── the tokens ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_activity_action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  -- The org-local day the token is good for. A visit on any other day is
  -- refused, whoever it belongs to.
  route_date date NOT NULL,
  -- SHA-256 of the token, hex. The token is never stored.
  token_hash text NOT NULL,
  -- The language the phone showed the route in, for the content state the
  -- hook sends back.
  locale text NOT NULL DEFAULT 'en',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_activity_action_tokens_hash_hex CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT live_activity_action_tokens_locale_check CHECK (locale IN ('en', 'es', 'ar', 'zh')),
  CONSTRAINT live_activity_action_tokens_revoke_reason_length CHECK (revoke_reason IS NULL OR char_length(revoke_reason) <= 200),
  -- Sixteen hours is the most a token may ever live.
  CONSTRAINT live_activity_action_tokens_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '16 hours 5 minutes'),
  CONSTRAINT live_activity_action_tokens_hash_unique UNIQUE (token_hash)
);

COMMENT ON TABLE public.live_activity_action_tokens IS
  'Single-purpose tokens that let the route Live Activity''s Start button act from the lock screen. One tech, one org, one route day; at most 16 hours; revoked when the activity ends. Only the SHA-256 is stored. Service role only.';

CREATE INDEX IF NOT EXISTS live_activity_action_tokens_live_by_user
  ON public.live_activity_action_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS live_activity_action_tokens_organization_id
  ON public.live_activity_action_tokens (organization_id);
CREATE INDEX IF NOT EXISTS live_activity_action_tokens_staff_id
  ON public.live_activity_action_tokens (staff_id);

ALTER TABLE public.live_activity_action_tokens ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.live_activity_action_tokens');

REVOKE ALL ON public.live_activity_action_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_activity_action_tokens TO service_role;

-- ── what was done with them ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_activity_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid NOT NULL REFERENCES public.live_activity_action_tokens(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  action text NOT NULL,
  -- pending while the transition runs; done once it has; failed when the
  -- transition raised (and may be tried again); refused never reaches here,
  -- because a refusal is decided before anything is written.
  outcome text NOT NULL DEFAULT 'pending',
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- Only Start, today. A wider list is a migration, not a client's choice.
  CONSTRAINT live_activity_actions_action_check CHECK (action IN ('start')),
  CONSTRAINT live_activity_actions_outcome_check CHECK (outcome IN ('pending', 'done', 'failed')),
  CONSTRAINT live_activity_actions_detail_length CHECK (detail IS NULL OR char_length(detail) <= 500),
  -- The idempotency key: a second tap for the same stop and the same button
  -- finds this row instead of starting the stop again.
  CONSTRAINT live_activity_actions_once UNIQUE (token_id, visit_id, action)
);

COMMENT ON TABLE public.live_activity_actions IS
  'Every Start pressed on a lock screen: who, which stop, when, and how it ended. Unique per (token, visit, action), which is what makes a double tap act once. Service role only.';

CREATE INDEX IF NOT EXISTS live_activity_actions_token_recent
  ON public.live_activity_actions (token_id, created_at);
CREATE INDEX IF NOT EXISTS live_activity_actions_organization_id
  ON public.live_activity_actions (organization_id);
CREATE INDEX IF NOT EXISTS live_activity_actions_user_id
  ON public.live_activity_actions (user_id);
CREATE INDEX IF NOT EXISTS live_activity_actions_visit_id
  ON public.live_activity_actions (visit_id);

ALTER TABLE public.live_activity_actions ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.live_activity_actions');

REVOKE ALL ON public.live_activity_actions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_activity_actions TO service_role;

-- ── one start, two callers ──────────────────────────────────────────────────
--
-- The body is start_visit's from 20260804060000, line for line, with
-- auth.uid() replaced by _actor.

CREATE OR REPLACE FUNCTION public.start_visit_as(
  _actor uuid,
  _visit_id uuid,
  _started_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _when timestamptz := now();
BEGIN
  IF _actor IS NULL OR NOT public.is_visit_tech(_actor, _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;

  -- Same bounds as the completion. A start time matters because completed_at
  -- is validated against it — a replayed start stamped with the sync time
  -- makes a legitimately earlier completion look impossible.
  IF _started_at IS NOT NULL
     AND _started_at <= now()
     AND _started_at >= now() - interval '7 days'
  THEN
    _when := _started_at;
  END IF;

  UPDATE public.visits
     SET status='in_progress',
         started_at = COALESCE(started_at, _when),
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
END;
$function$;

REVOKE ALL ON FUNCTION public.start_visit_as(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_visit_as(uuid, uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.start_visit_as(uuid, uuid, timestamptz) IS
  'start_visit with the actor named instead of read from the session. Service role only: the lock-screen hook calls it for the tech its action token names. start_visit is this with auth.uid().';

CREATE OR REPLACE FUNCTION public.start_visit(
  _visit_id uuid,
  _started_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.start_visit_as(auth.uid(), _visit_id, _started_at);
END;
$function$;

REVOKE ALL ON FUNCTION public.start_visit(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_visit(uuid, timestamptz) TO authenticated, service_role;

COMMENT ON FUNCTION public.start_visit(uuid, timestamptz) IS
  'Starts a visit. _started_at carries the time a QUEUED action was actually performed, bounded the same way as complete_visit. COALESCE keeps the first start, so a replay never overwrites a real one. The body is start_visit_as, with the caller as the actor.';

-- ── what this file establishes ──────────────────────────────────────────────
DO $check$
DECLARE
  _t text;
  _fk record;
BEGIN
  FOREACH _t IN ARRAY ARRAY['live_activity_action_tokens', 'live_activity_actions'] LOOP
    IF to_regclass('public.' || _t) IS NULL THEN
      RAISE EXCEPTION '% was not created', _t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || _t)::regclass) THEN
      RAISE EXCEPTION 'RLS is not enabled on %', _t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = _t
         AND permissive = 'RESTRICTIVE' AND policyname = 'two-step sign-in, when the user has it'
    ) THEN
      RAISE EXCEPTION '% has no two-step sign-in policy', _t;
    END IF;
    -- Service role only: no permissive policy, and no grant to a browser key.
    IF EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = _t AND permissive = 'PERMISSIVE'
    ) THEN
      RAISE EXCEPTION '% has a permissive policy; it is meant for the service role only', _t;
    END IF;
    IF has_table_privilege('anon', 'public.' || _t, 'SELECT')
       OR has_table_privilege('anon', 'public.' || _t, 'INSERT')
       OR has_table_privilege('anon', 'public.' || _t, 'UPDATE')
       OR has_table_privilege('anon', 'public.' || _t, 'DELETE')
       OR has_table_privilege('authenticated', 'public.' || _t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || _t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || _t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || _t, 'DELETE') THEN
      RAISE EXCEPTION 'a browser key holds a privilege on %', _t;
    END IF;
    FOR _fk IN
      SELECT c.conname, c.conkey FROM pg_constraint c
       WHERE c.conrelid = ('public.' || _t)::regclass AND c.contype = 'f'
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_index i
         WHERE i.indrelid = ('public.' || _t)::regclass AND i.indkey[0] = _fk.conkey[1]
      ) THEN
        RAISE EXCEPTION 'foreign key % on % has no index', _fk.conname, _t;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.live_activity_actions'::regclass
       AND conname = 'live_activity_actions_once' AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'live_activity_actions has no (token, visit, action) key, so a double tap could act twice';
  END IF;

  -- start_visit_as is the service role's alone: a browser key that could
  -- call it could name any actor.
  IF has_function_privilege('anon', 'public.start_visit_as(uuid, uuid, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.start_visit_as(uuid, uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser key can call start_visit_as and name any actor';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.start_visit_as(uuid, uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the service role cannot call start_visit_as';
  END IF;

  -- start_visit is unchanged in who may call it, and now runs the one body.
  IF has_function_privilege('anon', 'public.start_visit(uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute start_visit';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.start_visit(uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost start_visit';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.start_visit(uuid, timestamptz)'::regprocedure)
       !~ 'start_visit_as\(auth\.uid\(\)' THEN
    RAISE EXCEPTION 'start_visit does not delegate to start_visit_as';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.start_visit_as(uuid, uuid, timestamptz)'::regprocedure)
       !~ 'is_visit_tech\(_actor, _visit_id\)' THEN
    RAISE EXCEPTION 'start_visit_as does not authorize the actor it was given';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'start_visit') <> 1 THEN
    RAISE EXCEPTION 'start_visit must have exactly one signature';
  END IF;
END
$check$;
