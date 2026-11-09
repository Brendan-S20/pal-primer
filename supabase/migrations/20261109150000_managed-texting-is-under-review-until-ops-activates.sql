-- site-r2-05: Managed texting is on sale, and a business that buys it is
-- "Under review" until a HoundStack admin activates it (owner, 2026-11-08).
--
-- 20261029160000 (BUILD-3) switched a business on the moment Twilio approved
-- its toll-free verification. The owner's decision puts an admin/ops action
-- in front of that: from submit until an admin presses Activate on
-- /platform/addons, every screen says "Under review, usually ready shortly".
-- Texting switches on when BOTH have happened, in either order: the carrier's
-- approval (an unverified toll-free number is blocked by carriers, so an
-- admin cannot switch one on early) and the admin's activation.
--
--   ops_approved_at / ops_approved_by   the admin's activation. Set from NULL
--                                       once by lib/twilio-provisioning.server
--                                       `opsActivateTexting`.
--   texting_status_due()                an approval with no admin activation
--                                       is no longer "due": it waits on the
--                                       admin queue, not on the ten-minute poll.
--   platform_addons 'managed-sms'       the catalog copy says what happens
--                                       after purchase, in the same words.
--
-- A business that is already live keeps sending: its activation is
-- backfilled from activated_at, and nothing here touches
-- org_twilio_credentials or organizations.sms_from_number.
--
-- Fresh-build safe: the table and function are created by 20261029160000,
-- earlier in this sequence; the catalog row may not exist, so that update
-- warns rather than fails.
--
-- NOT APPLIED. Practice on a rolled-back copy first (approval:migration).

-- ── 1. The admin's activation ─────────────────────────────────────────────

ALTER TABLE public.org_texting_registrations
  ADD COLUMN IF NOT EXISTS ops_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS ops_approved_by uuid;

COMMENT ON COLUMN public.org_texting_registrations.ops_approved_at IS
  'When a HoundStack admin activated this business''s Managed texting (site-r2-05). '
  'Texting switches on only once this is set AND the verification is approved.';

-- Already live before this file: activated by the rule that applied then.
UPDATE public.org_texting_registrations
   SET ops_approved_at = activated_at
 WHERE activated_at IS NOT NULL
   AND ops_approved_at IS NULL;

-- ── 2. The poll asks only about what it can finish ─────────────────────────

CREATE OR REPLACE FUNCTION public.texting_status_due()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.org_texting_registrations r
     WHERE r.status IN ('submitted', 'in_review')
        -- Approved AND activated by an admin, but not yet switched on: the
        -- poll finishes the job. An approval no admin has activated waits on
        -- /platform/addons instead.
        OR (r.status = 'approved'
            AND r.ops_approved_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.org_twilio_credentials c
                             WHERE c.organization_id = r.organization_id))
  );
$fn$;

REVOKE ALL ON FUNCTION public.texting_status_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.texting_status_due() TO service_role;

-- ── 3. The catalog says what happens after purchase ────────────────────────

UPDATE public.platform_addons
   SET status = 'active',
       is_active = true,
       description =
         'Two-way texting with your clients from your own number, registered with carriers '
         'under your business name. HoundStack handles the setup and carrier filing for you, '
         'with consent and STOP handling built in. Add it, then submit your business details '
         'in Settings, Texting: it shows Under review, usually ready shortly, until we switch '
         'it on. No Twilio account of your own required.',
       updated_at = now()
 WHERE slug = 'managed-sms';

-- ── 4. Check what this file established ───────────────────────────────────

DO $check$
DECLARE
  _a record;
  _src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'org_texting_registrations'
                    AND column_name = 'ops_approved_at') THEN
    RAISE EXCEPTION 'org_texting_registrations.ops_approved_at is missing';
  END IF;

  IF EXISTS (SELECT 1 FROM public.org_texting_registrations
              WHERE activated_at IS NOT NULL AND ops_approved_at IS NULL) THEN
    RAISE EXCEPTION 'a live business has no recorded activation; it would read Under review';
  END IF;

  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.texting_status_due()'::regprocedure;
  IF _src !~ 'ops_approved_at IS NOT NULL' THEN
    RAISE EXCEPTION 'texting_status_due still counts an approval no admin has activated';
  END IF;
  IF has_function_privilege('anon', 'public.texting_status_due()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.texting_status_due()', 'EXECUTE') THEN
    RAISE EXCEPTION 'texting_status_due is executable by anon or authenticated';
  END IF;

  SELECT status, is_active, description INTO _a
    FROM public.platform_addons
   WHERE slug = 'managed-sms';
  IF NOT FOUND THEN
    RAISE WARNING 'no managed-sms add-on on this database; the catalog copy was not updated';
    RETURN;
  END IF;
  IF _a.status IS DISTINCT FROM 'active' OR _a.is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'managed texting is not on sale (status %, is_active %)', _a.status, _a.is_active;
  END IF;
  IF _a.description ~* 'coming soon' THEN
    RAISE EXCEPTION 'managed texting is on sale but its copy says coming soon';
  END IF;
  IF _a.description !~ 'Under review, usually ready shortly' THEN
    RAISE EXCEPTION 'the managed-texting copy does not say Under review, usually ready shortly';
  END IF;
END
$check$;
