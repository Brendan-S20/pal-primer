-- live_activity_tokens, proved against a real Postgres rather than read off
-- the migration's text. Run by tests/a-lock-screen-token-is-the-techs-own.test.ts,
-- which passes the migration's path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included, so this can be pointed at a shared local stack
-- without leaving a table or a row behind. Each group prints "ok: ..." only
-- when every check in it passed, or raises "PROOF FAILED [...]", and
-- ON_ERROR_STOP turns the first failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Org A: Sam and Priya, both techs. Org B: Omar, a tech.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a3000000-0000-4000-8000-00000000a001', 'sam-a@lockscreen.proof.invalid'),
  ('a3000000-0000-4000-8000-00000000a002', 'priya-a@lockscreen.proof.invalid'),
  ('b3000000-0000-4000-8000-00000000b001', 'omar-b@lockscreen.proof.invalid');

INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a300000-0000-4000-8000-0000000000aa', 'Lock Screen Proof A', 'America/Chicago'),
  ('0b300000-0000-4000-8000-0000000000bb', 'Lock Screen Proof B', 'America/Chicago');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a3000000-0000-4000-8000-00000000a001', '0a300000-0000-4000-8000-0000000000aa', 'tech'),
  ('a3000000-0000-4000-8000-00000000a002', '0a300000-0000-4000-8000-0000000000aa', 'tech'),
  ('b3000000-0000-4000-8000-00000000b001', '0b300000-0000-4000-8000-0000000000bb', 'tech');

-- Priya's activity, written as the service role would see it.
INSERT INTO public.live_activity_tokens (user_id, organization_id, activity_id, push_token, route_date)
VALUES ('a3000000-0000-4000-8000-00000000a002', '0a300000-0000-4000-8000-0000000000aa',
        'priya-activity', 'abcdef0123456789abcdef0123456789', '2026-10-04');

-- ── 1. A tech saves, re-saves and ends their own token ───────────────────────
SELECT set_config('request.jwt.claims',
  '{"sub":"a3000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _n int; _tok text; _ended timestamptz;
BEGIN
  INSERT INTO public.live_activity_tokens (user_id, organization_id, activity_id, push_token, route_date, locale)
  VALUES ('a3000000-0000-4000-8000-00000000a001', '0a300000-0000-4000-8000-0000000000aa',
          'sam-activity', '00112233445566778899aabbccddeeff', '2026-10-04', 'es');
  -- What saveLiveActivityToken does with a rotated token: an upsert on the
  -- (user_id, activity_id) constraint, which is a real one and not a partial
  -- index, so ON CONFLICT can name it.
  INSERT INTO public.live_activity_tokens (user_id, organization_id, activity_id, push_token, route_date, locale)
  VALUES ('a3000000-0000-4000-8000-00000000a001', '0a300000-0000-4000-8000-0000000000aa',
          'sam-activity', 'ffeeddccbbaa99887766554433221100', '2026-10-04', 'es')
  ON CONFLICT (user_id, activity_id) DO UPDATE SET push_token = EXCLUDED.push_token, updated_at = now();
  SELECT count(*), max(push_token) INTO _n, _tok FROM public.live_activity_tokens WHERE activity_id = 'sam-activity';
  IF _n <> 1 OR _tok <> 'ffeeddccbbaa99887766554433221100' THEN
    RAISE EXCEPTION 'PROOF FAILED [own]: % rows, token %', _n, _tok;
  END IF;
  UPDATE public.live_activity_tokens SET ended_at = now(), end_reason = 'finished'
   WHERE activity_id = 'sam-activity';
  SELECT ended_at INTO _ended FROM public.live_activity_tokens WHERE activity_id = 'sam-activity';
  IF _ended IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [own]: the tech could not end their own token'; END IF;
  RAISE NOTICE 'ok: a tech saves, rotates and ends their own token, and a rotation is one row';
END $$;

-- ── 2. ...and nobody else's ──────────────────────────────────────────────────
DO $$
DECLARE _n int; _err text;
BEGIN
  SELECT count(*) INTO _n FROM public.live_activity_tokens WHERE activity_id = 'priya-activity';
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [others]: Sam can read Priya''s token'; END IF;

  UPDATE public.live_activity_tokens SET push_token = '0000000000000000'
   WHERE activity_id = 'priya-activity';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [others]: Sam rewrote Priya''s token'; END IF;

  DELETE FROM public.live_activity_tokens WHERE activity_id = 'priya-activity';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [others]: Sam deleted Priya''s token'; END IF;

  _err := NULL;
  BEGIN
    INSERT INTO public.live_activity_tokens (user_id, organization_id, activity_id, push_token, route_date)
    VALUES ('a3000000-0000-4000-8000-00000000a002', '0a300000-0000-4000-8000-0000000000aa',
            'forged', '0123456789abcdef0123', '2026-10-04');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [others]: Sam saved a token in Priya''s name'; END IF;
  RAISE NOTICE 'ok: a tech cannot read, rewrite, delete or forge a teammate''s token';
END $$;

-- ── 3. ...and not in an org they do not belong to ───────────────────────────
DO $$
DECLARE _err text;
BEGIN
  _err := NULL;
  BEGIN
    INSERT INTO public.live_activity_tokens (user_id, organization_id, activity_id, push_token, route_date)
    VALUES ('a3000000-0000-4000-8000-00000000a001', '0b300000-0000-4000-8000-0000000000bb',
            'elsewhere', '0123456789abcdef0123', '2026-10-04');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [org]: Sam saved a token under another business'; END IF;

  _err := NULL;
  BEGIN
    UPDATE public.live_activity_tokens SET organization_id = '0b300000-0000-4000-8000-0000000000bb'
     WHERE activity_id = 'sam-activity';
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [org]: Sam moved their token into another business'; END IF;
  RAISE NOTICE 'ok: a token can only be saved in, or moved to, a business the tech belongs to';
END $$;

-- ── 4. The values are what the sender expects ───────────────────────────────
DO $$
DECLARE _err text;
BEGIN
  _err := NULL;
  BEGIN
    INSERT INTO public.live_activity_tokens (user_id, organization_id, activity_id, push_token, route_date)
    VALUES ('a3000000-0000-4000-8000-00000000a001', '0a300000-0000-4000-8000-0000000000aa',
            'bad-token', 'not hex at all', '2026-10-04');
  EXCEPTION WHEN check_violation THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [shape]: a token that is not hex was stored'; END IF;

  _err := NULL;
  BEGIN
    INSERT INTO public.live_activity_tokens (user_id, organization_id, activity_id, push_token, route_date, locale)
    VALUES ('a3000000-0000-4000-8000-00000000a001', '0a300000-0000-4000-8000-0000000000aa',
            'bad-locale', '0123456789abcdef0123', '2026-10-04', 'fr');
  EXCEPTION WHEN check_violation THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [shape]: a language the server cannot write was stored'; END IF;
  RAISE NOTICE 'ok: a token is hex and a language is one the server has translations for';
END $$;
RESET ROLE;

-- ── 5. Signed out, nothing; the service role, everything ────────────────────
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  _err := NULL;
  BEGIN
    PERFORM 1 FROM public.live_activity_tokens LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: a signed-out caller can query live_activity_tokens'; END IF;
  RAISE NOTICE 'ok: a signed-out caller cannot touch the table';
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SET ROLE service_role;
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.live_activity_tokens
   WHERE organization_id = '0a300000-0000-4000-8000-0000000000aa';
  IF _n <> 2 THEN RAISE EXCEPTION 'PROOF FAILED [sender]: the service role sees % of 2 tokens', _n; END IF;
  UPDATE public.live_activity_tokens SET ended_at = now(), end_reason = 'BadDeviceToken'
   WHERE activity_id = 'priya-activity';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [sender]: the sender could not switch a dead token off'; END IF;
  RAISE NOTICE 'ok: the sender reads every token and can switch a dead one off';
END $$;
RESET ROLE;

ROLLBACK;

\echo ALL LIVE ACTIVITY TOKEN PROOFS PASSED
