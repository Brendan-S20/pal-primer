-- A lead is noticed, and a script cannot fill the pipeline it is noticed in.
--
-- Two follow-ups from the merged public form (/signup/{slug}, #360). The first
-- is app code: the office is now told about a new lead, in the bell and on the
-- phone (src/lib/lead-notify.server.ts). The second is what makes the first
-- safe to ship. A form that writes into a business's pipeline AND buzzes the
-- owner's phone is a form worth spamming, so it now stands behind a honeypot, a
-- time-to-submit check and a rate limit (src/lib/public-form-guard.ts). This
-- file is the database half of that rate limit, and the closing of the side
-- door that would have made it decorative.
--
-- ── 1. THE COUNTER ─────────────────────────────────────────────────────────
--
-- `public_form_attempts`: one row per lead-writing submission that was let
-- through, keyed by business and by a salted hash of the caller's address.
-- The portal_code_attempts pattern (an attempt log counted over a window,
-- 20260709120000) with the roadmap poll's two refinements (20260913100000):
-- the address is hashed before it is stored, and old rows are pruned by the
-- function that writes new ones, bounded, so nothing has to be scheduled.
--
-- No foreign key to organizations, on purpose: a row is a count, it lives a
-- day, and the self-check below has to be able to exercise the limit on an
-- empty database, which has no organization to point at.
--
-- RLS on, no policy (deny-all), the two-step policy as every RLS table gets
-- (20261002010000), and no grant to anon or authenticated. Only the service
-- role reaches it, through the function.
--
-- ── 2. THE TURN ────────────────────────────────────────────────────────────
--
-- `take_public_form_turn(org, ip_hash, per_address, per_business, window)`
-- answers 'ok' and counts the submission, or answers 'address' / 'business'
-- and counts nothing, so a refused submission writes nothing at all. The
-- limits are arguments because the numbers are the app's decision and live
-- beside the rest of the policy in public-form-guard.ts, where the tests read
-- them. The check and the write are one call under advisory locks (business
-- first, then address, always in that order, so two calls cannot wait on each
-- other), so two requests in the same instant cannot both read "one under".
-- SECURITY INVOKER, executable by the service role only: nothing anonymous
-- calls it, the server does, after it has decided who the business is.
--
-- ── 3. THE SIDE DOOR ───────────────────────────────────────────────────────
--
-- The quote request posted to /api/public/leads, which wrote with the
-- PUBLISHABLE key under "Anyone can submit a lead to a business that publishes
-- a form" (20260804030000, tightened 20260928090000). That policy kept a
-- submission honest about WHICH business and WHAT state, and its own header
-- says what it did not do: "Rate-limit... Stated so nobody reads this as spam
-- protection." With the policy in place, every check this change adds is one
-- POST to /rest/v1/leads away from irrelevant, because the publishable key is
-- in every browser. So the policy is dropped and anon's INSERT grant revoked:
-- the endpoint writes with the service role now, behind the filters, setting
-- status 'new' itself. Every other writer of `leads` (the signup, the AI
-- receptionist, the demo seed) was already the service role or a SECURITY
-- DEFINER function and is unaffected. Order of deploy is safe either way: the
-- app (which ships first) no longer uses the policy, and until this file is
-- applied the limiter answers with an error, which public-form-guard.server.ts
-- treats as "let it through".
--
-- `org_accepts_public_leads` stays. Nothing calls it after this, but it is a
-- harmless STABLE boolean, three tests read its definition, and dropping a
-- function is a different change from closing a door.
--
-- ── REPLAY ─────────────────────────────────────────────────────────────────
--
-- A new table, a new function, a dropped policy and a revoke: all of it from
-- nothing, all idempotent. The self-check at the bottom proves the limit end
-- to end with a probe business id that cannot exist and removes its rows, so
-- an empty database proves exactly what production does.

CREATE TABLE IF NOT EXISTS public.public_form_attempts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  ip_hash         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.public_form_attempts IS
  'One row per public-form submission that was allowed to write a lead, for the rate limit in take_public_form_turn. '
  'ip_hash is a salted SHA-256 of the caller address (public-form-guard.server.ts), never the address. '
  'Deny-all; reached only by the service role through take_public_form_turn, which prunes rows older than a day.';

CREATE INDEX IF NOT EXISTS public_form_attempts_org_idx
  ON public.public_form_attempts (organization_id, created_at);
CREATE INDEX IF NOT EXISTS public_form_attempts_ip_idx
  ON public.public_form_attempts (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS public_form_attempts_created_idx
  ON public.public_form_attempts (created_at);

ALTER TABLE public.public_form_attempts ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.public_form_attempts');
-- No permissive policies, on purpose: deny-all.

REVOKE ALL ON public.public_form_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.public_form_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.take_public_form_turn(
  _org_id         uuid,
  _ip_hash        text,
  _per_address    integer,
  _per_business   integer,
  _window_seconds integer
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  _since timestamptz;
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'take_public_form_turn: no business';
  END IF;
  IF coalesce(_per_address, 0) < 1 OR coalesce(_per_business, 0) < 1 THEN
    RAISE EXCEPTION 'take_public_form_turn: limits must be at least 1';
  END IF;
  -- The prune below keeps a day; a longer window would count rows it deleted.
  IF coalesce(_window_seconds, 0) < 1 OR _window_seconds > 86400 THEN
    RAISE EXCEPTION 'take_public_form_turn: window must be 1 second to 1 day';
  END IF;
  _since := now() - make_interval(secs => _window_seconds);

  -- Business first, address second, every time: one order, so no two calls
  -- can each hold the lock the other wants.
  PERFORM pg_advisory_xact_lock(hashtext('public_form_turn:org:' || _org_id::text));
  IF _ip_hash IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('public_form_turn:ip:' || _ip_hash));
  END IF;

  -- Bounded, so a busy day cannot turn one submission into a full-table DELETE.
  DELETE FROM public.public_form_attempts
   WHERE id IN (
     SELECT id FROM public.public_form_attempts
      WHERE created_at < now() - interval '1 day'
      ORDER BY created_at
      LIMIT 500
   );

  IF _ip_hash IS NOT NULL AND (
    SELECT count(*) FROM public.public_form_attempts
     WHERE ip_hash = _ip_hash AND created_at >= _since
  ) >= _per_address THEN
    RETURN 'address';
  END IF;

  IF (
    SELECT count(*) FROM public.public_form_attempts
     WHERE organization_id = _org_id AND created_at >= _since
  ) >= _per_business THEN
    RETURN 'business';
  END IF;

  INSERT INTO public.public_form_attempts (organization_id, ip_hash)
  VALUES (_org_id, _ip_hash);
  RETURN 'ok';
END;
$function$;

COMMENT ON FUNCTION public.take_public_form_turn(uuid, text, integer, integer, integer) IS
  'Rate limit for the public form: ''ok'' (and counted), or ''address'' / ''business'' (and not counted). '
  'Called by the server with the service role after it has resolved the business; see src/lib/public-form-guard.server.ts.';

REVOKE ALL ON FUNCTION public.take_public_form_turn(uuid, text, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.take_public_form_turn(uuid, text, integer, integer, integer)
  TO service_role;

-- The side door.
DROP POLICY IF EXISTS "Anyone can submit a lead to a business that publishes a form" ON public.leads;
DROP POLICY IF EXISTS "Anyone can submit a lead" ON public.leads;
REVOKE INSERT ON public.leads FROM anon;

-- ── What this establishes. Provable from an empty database, so exceptions. ──

DO $est$
DECLARE
  _probe  uuid := '00000000-0000-4000-8000-00000000f0f0';
  _answer text;
  _rows   integer;
BEGIN
  IF to_regclass('public.public_form_attempts') IS NULL THEN
    RAISE EXCEPTION 'public_form_attempts was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.public_form_attempts'::regclass) THEN
    RAISE EXCEPTION 'public_form_attempts has RLS disabled; it holds address hashes';
  END IF;
  -- Permissive only: the two-step policy is RESTRICTIVE and can only take
  -- access away (CLAUDE.md, #302).
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'public_form_attempts'
                AND permissive = 'PERMISSIVE') THEN
    RAISE EXCEPTION 'public_form_attempts has a permissive policy; it is deny-all on purpose';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'public_form_attempts'
                    AND policyname = 'two-step sign-in, when the user has it') THEN
    RAISE EXCEPTION 'public_form_attempts is missing the two-step policy';
  END IF;
  IF has_table_privilege('anon', 'public.public_form_attempts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.public_form_attempts', 'SELECT') THEN
    RAISE EXCEPTION 'public_form_attempts is readable by a browser role';
  END IF;

  IF has_function_privilege('anon', 'public.take_public_form_turn(uuid,text,integer,integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.take_public_form_turn(uuid,text,integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'take_public_form_turn is callable from a browser';
  END IF;

  -- The side door is shut.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'leads'
                AND cmd IN ('INSERT', 'ALL') AND permissive = 'PERMISSIVE') THEN
    RAISE EXCEPTION 'leads still has a permissive INSERT policy; a browser can write past the rate limit';
  END IF;
  IF has_table_privilege('anon', 'public.leads', 'INSERT') THEN
    RAISE EXCEPTION 'anon can still INSERT into leads';
  END IF;

  -- The limit, end to end. Three from one address go through and the fourth
  -- does not; a refusal is not counted; another address still gets in until
  -- the business's own ceiling (five here), which then refuses everyone.
  DELETE FROM public.public_form_attempts WHERE organization_id = _probe;
  FOR i IN 1..3 LOOP
    _answer := public.take_public_form_turn(_probe, 'probe-a', 3, 5, 3600);
    IF _answer <> 'ok' THEN
      RAISE EXCEPTION 'the limit refused submission % of 3 from one address: %', i, _answer;
    END IF;
  END LOOP;
  _answer := public.take_public_form_turn(_probe, 'probe-a', 3, 5, 3600);
  IF _answer <> 'address' THEN
    RAISE EXCEPTION 'a fourth submission from one address was not refused: %', _answer;
  END IF;
  SELECT count(*) INTO _rows FROM public.public_form_attempts WHERE organization_id = _probe;
  IF _rows <> 3 THEN
    RAISE EXCEPTION 'a refused submission was counted: % rows, want 3', _rows;
  END IF;

  FOR i IN 1..2 LOOP
    _answer := public.take_public_form_turn(_probe, 'probe-b', 3, 5, 3600);
    IF _answer <> 'ok' THEN
      RAISE EXCEPTION 'another address was refused under the business ceiling: %', _answer;
    END IF;
  END LOOP;
  _answer := public.take_public_form_turn(_probe, NULL, 3, 5, 3600);
  IF _answer <> 'business' THEN
    RAISE EXCEPTION 'the business ceiling did not hold: %', _answer;
  END IF;

  DELETE FROM public.public_form_attempts WHERE organization_id = _probe;
  RAISE NOTICE 'ok: the public form limit holds per address and per business, and a refusal writes nothing';
END
$est$;
