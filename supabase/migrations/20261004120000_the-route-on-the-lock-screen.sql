-- The route on the lock screen.
--
-- A technician's day now shows on the iPhone lock screen and in the Dynamic
-- Island as a Live Activity: "Stop 5 of 12", the next stop's street, its
-- arrival window, done and skipped counts. The phone keeps it current by
-- itself while the tech works the route in the app. What the phone cannot see
-- is the OFFICE changing the day -- a stop reassigned away, a visit added,
-- the route re-sequenced, a stop canceled -- and for that iOS gives every
-- Live Activity its own APNs push token, which only works if the server has
-- it. This table is where it is kept.
--
-- One row per activity. A token belongs to one activity on one phone for one
-- route day, so the row says which user, which org, which day, and the
-- language the phone was showing it in: the server rebuilds the content in
-- that language (src/lib/push-liveactivity.server.ts) with the same
-- translations My Day uses, because the extension draws exactly the strings
-- it is sent and has no translations of its own.
--
-- `ended_at` rather than DELETE, the way push_subscriptions uses `disabled`:
-- an activity the tech swiped away, finished, or clocked out of, and a token
-- APNs answered 410 or BadDeviceToken for, is switched off with the reason
-- beside it, so "why did the lock screen stop updating" has an answer in the
-- row. Every sender reads `ended_at IS NULL` only.
--
-- A user manages only their own rows, and only in an org they belong to. The
-- server sends with the service role, which RLS does not apply to. No
-- function is created here, so there is nothing to REVOKE beyond the table's
-- own grants.
--
-- Replays into an empty database: one table, its indexes, its policies. The
-- check block asserts what this file establishes and needs no row.

CREATE TABLE IF NOT EXISTS public.live_activity_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- ActivityKit's id for the activity, a UUID string minted on the phone.
  activity_id text NOT NULL,
  -- The activity's APNs push token, hex. Not the device token in
  -- push_subscriptions: a different token, for a different push type.
  push_token text NOT NULL,
  -- The org-local day the route is for.
  route_date date NOT NULL,
  -- The interface language the phone showed it in: en, es, ar or zh.
  locale text NOT NULL DEFAULT 'en',
  -- What the server last pushed, so an unchanged route is not pushed again
  -- and a minor change goes at priority 5 rather than 10.
  last_state jsonb,
  last_sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  CONSTRAINT live_activity_tokens_activity_id_length CHECK (char_length(activity_id) BETWEEN 1 AND 200),
  CONSTRAINT live_activity_tokens_push_token_hex CHECK (push_token ~ '^[0-9a-f]+$' AND char_length(push_token) BETWEEN 16 AND 512),
  CONSTRAINT live_activity_tokens_locale_check CHECK (locale IN ('en', 'es', 'ar', 'zh')),
  CONSTRAINT live_activity_tokens_end_reason_length CHECK (end_reason IS NULL OR char_length(end_reason) <= 200),
  CONSTRAINT live_activity_tokens_last_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  CONSTRAINT live_activity_tokens_user_activity UNIQUE (user_id, activity_id)
);

COMMENT ON TABLE public.live_activity_tokens IS
  'APNs push tokens for the route Live Activity on a technician''s iPhone, one row per activity. Written by the phone through saveLiveActivityToken; read by the service role in src/lib/push-liveactivity.server.ts when the office changes that tech''s day. ended_at switches a row off; nothing deletes one.';

-- The sender's lookup: a tech's live activities for one day.
CREATE INDEX IF NOT EXISTS live_activity_tokens_live_by_user_day
  ON public.live_activity_tokens (user_id, route_date) WHERE ended_at IS NULL;
-- And an org's, for a change that moves work between techs.
CREATE INDEX IF NOT EXISTS live_activity_tokens_organization_id
  ON public.live_activity_tokens (organization_id);

ALTER TABLE public.live_activity_tokens ENABLE ROW LEVEL SECURITY;

-- Two-step sign-in, like every RLS table (20261002010000_a-password-was-the-only-lock).
SELECT public.require_mfa_policy('public.live_activity_tokens');

REVOKE ALL ON public.live_activity_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_activity_tokens TO authenticated;
GRANT ALL ON public.live_activity_tokens TO service_role;

DROP POLICY IF EXISTS "live activity tokens: your own (select)" ON public.live_activity_tokens;
CREATE POLICY "live activity tokens: your own (select)" ON public.live_activity_tokens
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "live activity tokens: your own, in your org (insert)" ON public.live_activity_tokens;
CREATE POLICY "live activity tokens: your own, in your org (insert)" ON public.live_activity_tokens
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.is_org_member((SELECT auth.uid()), organization_id)
  );

DROP POLICY IF EXISTS "live activity tokens: your own, in your org (update)" ON public.live_activity_tokens;
CREATE POLICY "live activity tokens: your own, in your org (update)" ON public.live_activity_tokens
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.is_org_member((SELECT auth.uid()), organization_id)
  );

DROP POLICY IF EXISTS "live activity tokens: your own (delete)" ON public.live_activity_tokens;
CREATE POLICY "live activity tokens: your own (delete)" ON public.live_activity_tokens
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

DO $check$
DECLARE
  _fk record;
  _p record;
BEGIN
  IF to_regclass('public.live_activity_tokens') IS NULL THEN
    RAISE EXCEPTION 'live_activity_tokens was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.live_activity_tokens'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on live_activity_tokens';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'live_activity_tokens'
       AND permissive = 'RESTRICTIVE' AND policyname = 'two-step sign-in, when the user has it'
  ) THEN
    RAISE EXCEPTION 'live_activity_tokens has no two-step sign-in policy';
  END IF;

  IF has_table_privilege('anon', 'public.live_activity_tokens', 'SELECT')
     OR has_table_privilege('anon', 'public.live_activity_tokens', 'INSERT')
     OR has_table_privilege('anon', 'public.live_activity_tokens', 'UPDATE')
     OR has_table_privilege('anon', 'public.live_activity_tokens', 'DELETE') THEN
    RAISE EXCEPTION 'anon holds a privilege on live_activity_tokens';
  END IF;
  IF has_table_privilege('authenticated', 'public.live_activity_tokens', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated can truncate live_activity_tokens';
  END IF;

  -- Exactly one permissive policy per command, and every one of them is
  -- scoped to the caller: no FOR ALL, nothing granted to PUBLIC.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'live_activity_tokens'
         AND permissive = 'PERMISSIVE') <> 4
     OR EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'live_activity_tokens'
          AND permissive = 'PERMISSIVE' AND (cmd = 'ALL' OR roles <> ARRAY['authenticated']::name[])
     ) THEN
    RAISE EXCEPTION 'live_activity_tokens needs exactly four permissive policies, one per command, for authenticated only';
  END IF;
  FOR _p IN
    SELECT policyname, cmd, qual, with_check FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'live_activity_tokens' AND permissive = 'PERMISSIVE'
  LOOP
    IF _p.cmd IN ('SELECT', 'UPDATE', 'DELETE')
       AND position('user_id = ( SELECT auth.uid()' IN COALESCE(_p.qual, '')) = 0 THEN
      RAISE EXCEPTION 'policy "%" does not limit % to the caller''s own rows', _p.policyname, _p.cmd;
    END IF;
    IF _p.cmd IN ('INSERT', 'UPDATE')
       AND (position('user_id = ( SELECT auth.uid()' IN COALESCE(_p.with_check, '')) = 0
            OR position('is_org_member' IN COALESCE(_p.with_check, '')) = 0) THEN
      RAISE EXCEPTION 'policy "%" lets a row be written for another user or another org', _p.policyname;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.live_activity_tokens'::regclass
       AND conname = 'live_activity_tokens_user_activity' AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'live_activity_tokens has no (user_id, activity_id) unique constraint, so a token save cannot upsert';
  END IF;

  FOR _fk IN
    SELECT c.conname, c.conkey FROM pg_constraint c
     WHERE c.conrelid = 'public.live_activity_tokens'::regclass AND c.contype = 'f'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = 'public.live_activity_tokens'::regclass
         AND i.indkey[0] = _fk.conkey[1]
    ) THEN
      RAISE EXCEPTION 'foreign key % on live_activity_tokens has no index', _fk.conname;
    END IF;
  END LOOP;
END
$check$;
