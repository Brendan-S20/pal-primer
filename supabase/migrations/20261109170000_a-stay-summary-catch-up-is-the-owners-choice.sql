-- A stay summary catch-up is the owner's choice (#411, #747; Brendan via
-- Product, 2026-11-09).
--
-- 20261109120000's companion code added a nightly catch for stay summaries:
-- a stay whose last visit was skipped or went missed never ran the completion
-- path, so its client never got the end-of-stay summary, and the nightly job
-- now sends it, looking back 7 days. On the first night after deploy that
-- would email every client whose stay settled that way in the week before,
-- for a feature none of them had been promised. The decision: no backlog by
-- default, and the business chooses whether it wants one.
--
-- 1. organizations.stay_summary_catch_up, boolean, default false.
--      false  the nightly catch looks back no further than the moment the
--             catch went live for this business (column 2).
--      true   it looks back the full 7 days, as written.
--    Either way a summary already sent is never sent again: the email's
--    idempotency key is the stay's (stay-summary-<stay id>), unchanged.
--
-- 2. organizations.stay_summaries_live_at, timestamptz: when the catch went
--    live for this business, which is the later of
--      * when this file ran (deploy): every existing row is filled with this
--        transaction's now(), because ADD COLUMN ... DEFAULT now() evaluates
--        the default once for the rows already there, and
--      * when the business started pet sitting: tg_orgs_stay_summary_settings
--        stamps now() whenever pet_sitting is newly in service_lines, on an
--        INSERT or an UPDATE. A business created later starts at its own
--        creation (the default), or later still when it adds sitting.
--    The nightly code reads it as a date on the business's own calendar and
--    sends nothing for a stay that ended before that date
--    (src/lib/sit-report.server.ts, sendSettledStaySummaries).
--
-- 3. set_stay_summary_catch_up(_org_id, _on): an owner or an office manager
--    of that business, the same gate as set_training_series_skip_closed
--    (has_role owner OR office_manager); anyone else, a tech and a dispatcher
--    included, is refused with insufficient_privilege. SECURITY DEFINER,
--    search_path pinned, revoked from PUBLIC and anon.
--
-- 4. Nobody signed in moves either column any other way. The organizations
--    update policy would otherwise let a direct PATCH through, so
--    tg_orgs_stay_summary_settings refuses a change to either column from a
--    signed-in caller unless set_stay_summary_catch_up set the transaction
--    flag, the way organizations_guard_vaccine_start_rule (20261108153100)
--    guards the vaccine rule. The service role and migrations (auth.uid()
--    null) are let through, as for every other organizations column.
--
-- Replays into an empty database: two columns, two functions, one trigger.
-- The check block asserts what this file establishes and needs no row.

-- ── 1, 2. The columns ─────────────────────────────────────────────────────

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stay_summary_catch_up boolean NOT NULL DEFAULT false;
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stay_summaries_live_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.organizations.stay_summary_catch_up IS
  'Whether the nightly stay-summary catch looks back the full 7 days (true) or only to stay_summaries_live_at (false, the default: no backlog). Changed only through set_stay_summary_catch_up, by an owner or office manager. Migration 20261109170000.';
COMMENT ON COLUMN public.organizations.stay_summaries_live_at IS
  'When the nightly stay-summary catch went live for this business: the later of this column''s migration (20261109170000) and the business starting pet sitting. Stamped by tg_orgs_stay_summary_settings; nobody signed in writes it.';

-- ── 3, 4. The trigger: guard both columns, stamp the go-live time ─────────

CREATE OR REPLACE FUNCTION public.tg_orgs_stay_summary_settings()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.stay_summary_catch_up IS DISTINCT FROM OLD.stay_summary_catch_up
          OR NEW.stay_summaries_live_at IS DISTINCT FROM OLD.stay_summaries_live_at)
     AND auth.uid() IS NOT NULL
     AND COALESCE(current_setting('app.stay_summary_catch_up_writer', true), '') <> '1'
  THEN
    RAISE EXCEPTION 'Only an owner or office manager can change the stay summary catch-up'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The go-live moment: the business has just started pet sitting.
  IF 'pet_sitting' = ANY(COALESCE(NEW.service_lines, '{}'))
     AND (TG_OP = 'INSERT' OR NOT ('pet_sitting' = ANY(COALESCE(OLD.service_lines, '{}'))))
  THEN
    NEW.stay_summaries_live_at := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_orgs_stay_summary_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tg_orgs_stay_summary_settings ON public.organizations;
CREATE TRIGGER tg_orgs_stay_summary_settings
  BEFORE INSERT OR UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.tg_orgs_stay_summary_settings();

CREATE OR REPLACE FUNCTION public.set_stay_summary_catch_up(_org_id uuid, _on boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.has_role((select auth.uid()), _org_id, 'owner')
    OR public.has_role((select auth.uid()), _org_id, 'office_manager')
  ) THEN
    RAISE EXCEPTION 'Only an owner or office manager can change the stay summary catch-up'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF _on IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = 'Choose whether to send summaries for stays that ended before this was turned on.';
  END IF;
  PERFORM set_config('app.stay_summary_catch_up_writer', '1', true);
  UPDATE public.organizations SET stay_summary_catch_up = _on WHERE id = _org_id;
  IF NOT FOUND THEN
    PERFORM set_config('app.stay_summary_catch_up_writer', '', true);
    RAISE EXCEPTION 'Organization not found';
  END IF;
  PERFORM set_config('app.stay_summary_catch_up_writer', '', true);
  RETURN _on;
END;
$$;
REVOKE ALL ON FUNCTION public.set_stay_summary_catch_up(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_stay_summary_catch_up(uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.set_stay_summary_catch_up(uuid, boolean) IS
  'An owner or office manager turns the nightly stay-summary catch-up on or off for their business. Anyone else, a tech or a dispatcher included, is refused (insufficient_privilege). Migration 20261109170000.';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'organizations'
                    AND column_name = 'stay_summary_catch_up' AND is_nullable = 'NO'
                    AND column_default = 'false')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'organizations'
                    AND column_name = 'stay_summaries_live_at' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'organizations.stay_summary_catch_up or stay_summaries_live_at is missing or wrong';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.organizations'::regclass
                    AND tgname = 'tg_orgs_stay_summary_settings' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'trigger tg_orgs_stay_summary_settings is missing or disabled';
  END IF;
  IF has_function_privilege('anon', 'public.set_stay_summary_catch_up(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_orgs_stay_summary_settings()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_stay_summary_catch_up(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'set_stay_summary_catch_up or its trigger has the wrong grants';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.set_stay_summary_catch_up(uuid, boolean)'::regprocedure)
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.set_stay_summary_catch_up(uuid, boolean)'::regprocedure)
        NOT LIKE '%''office_manager''%' THEN
    RAISE EXCEPTION 'set_stay_summary_catch_up is not the owner-or-office-manager definer function';
  END IF;
END
$check$;
