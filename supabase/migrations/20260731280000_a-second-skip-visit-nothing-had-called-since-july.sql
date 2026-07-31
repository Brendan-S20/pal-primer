-- A second skip_visit, granted to every signed-in user, called by nothing.
--
-- ── HOW IT GOT HERE ────────────────────────────────────────────────────────
--
-- 20260701161658 created public.skip_visit(uuid, text) and granted EXECUTE to
-- `authenticated`. Two days later 20260701165623 added the reason-code version,
-- skip_visit(uuid, text, skip_reason_code) — a NEW signature, so Postgres kept
-- both. The app moved to the three-argument form and never looked back:
-- src/lib/my-day.functions.ts always sends _code, so PostgREST has resolved to
-- the newer overload ever since.
--
-- The two-argument one has sat there since 2026-07-01, executable by anyone
-- signed in, reachable by nothing.
--
-- ── WHY THE DEAD-MACHINERY DETECTOR DID NOT SEE IT ─────────────────────────
--
-- Because rule 1 keys on the NAME. `defined` is a Map<name, …> and
-- `grantedToApp` a Set<name>, so two signatures collapse into one entry, and
-- the live overload's callers vouch for the dead one. This is the same shape
-- as the two defects the detector's own review turned up: not a rule that
-- fails, a rule that cannot ask the question. Recorded in the detector's
-- header rather than left for the next person to rediscover.
--
-- Verified before writing this, against the live database:
--   * exactly one overload set exists in the whole public schema, this one;
--   * no function body in the schema calls skip_visit — office_skip_visit only
--     matched because its own CREATE line contains the substring;
--   * no policy or trigger depends on either signature.
--
-- ── WHY DROPPING IS SAFE ───────────────────────────────────────────────────
--
-- Dropping the two-argument form cannot change which function the app reaches,
-- because the app has never reached it: every call site passes _code. What it
-- does remove is the ambiguity — a future caller that omits _code would today
-- silently land on the older body, which predates the org skip-billing rules.

DROP FUNCTION IF EXISTS public.skip_visit(uuid, text);

DO $$
BEGIN
  IF to_regprocedure('public.skip_visit(uuid, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'the superseded two-argument skip_visit is still present';
  END IF;
  -- And the one the app actually calls must still be here. A drop that took
  -- the wrong overload with it would look identical in the migration log.
  IF to_regprocedure('public.skip_visit(uuid, text, skip_reason_code)') IS NULL THEN
    RAISE EXCEPTION 'the three-argument skip_visit is gone — the app cannot skip a visit';
  END IF;
END $$;
