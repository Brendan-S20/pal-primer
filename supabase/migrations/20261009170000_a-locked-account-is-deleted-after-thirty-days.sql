-- A locked account is deleted after thirty days (owner, 2026-10-09; spec NP-12).
--
-- Day 14 with no plan locks an account, and its data is kept for 30 days. A
-- cancelled plan that has ended can export its data for 30 days. After that the
-- account's data is deleted, by a job that SHIPS DISABLED (src/lib/
-- account-deletion.server.ts: ACCOUNT_DELETION_ENABLED = false). Until the owner
-- turns it on, after reading a production dry run, it only ever counts.
--
-- This file builds what the job calls. It deletes nothing when it runs.
--
-- ── WHEN AN ACCOUNT IS DUE ────────────────────────────────────────────────
--
--   trial_ended  trial_ends_at has passed, no paid status, no subscription,
--                created on/after 2026-08-16 (TRIAL_ENFORCEMENT_FROM in
--                src/lib/trial.ts; earlier accounts were promised no lock).
--   plan_ended   plan_status or billing_status is 'canceled' (Stripe ended the
--                subscription), dated from current_period_end.
--
--   delete_after = GREATEST(locked_since, deploy date) + 30 days
--
-- so an account that was already locked or cancelled before the deploy gets a
-- full 30 days from the deploy, and nothing is ever due on deploy day. Choosing
-- a plan makes the account paying again, which removes it from the candidates
-- on the next run: the scheduled deletion is cancelled by the state itself.
--
-- Never due: comped accounts, suspended accounts (a platform decision with its
-- own process), and accounts with no trial clock at all (pre-trial signups).
--
-- ── WHAT IS DELETED, WHAT IS KEPT ─────────────────────────────────────────
--
-- The organization row is NOT deleted: invoices, payments and the platform's
-- own invoices hang off it with ON DELETE CASCADE, and those are kept.
--
--   KEPT, ANONYMISED
--     organizations         the row; name, contact details, location, logo,
--                           review/receptionist text, SMS sender and consent,
--                           signup UTM and portal slugs cleared; deleted_at set
--     invoices              amounts, dates, status kept; notes, checkout_url cleared
--     invoice_line_items    kept with their invoice (visit/subscription links
--                           fall to NULL as those rows go)
--     payments              amounts, dates, method kept; raw_event cleared
--     credit_ledger         money movements kept
--     clients               ONLY those with an invoice (invoices.client_id is
--                           RESTRICT): name -> 'Deleted client', every contact,
--                           note, card and consent field cleared
--     staff                 rows kept for attribution, every personal field
--                           cleared, active = false (as delete_my_account does)
--     activity_log          kept; client link, actor label and meta cleared,
--                           summary reduced to its kind
--     platform_admin_audit  kept; before/after JSON cleared
--   KEPT AS IS
--     platform_invoices, org_platform_addons, platform_support_notes
--                           (HoundStack's own billing and support records)
--     sms_consent_records   NEW, below: SMS consent is copied here first and
--                           kept under its own retention rule, never by this job
--     account_deletion_schedule
--   DELETED
--     every other row in every public table with an organization_id column,
--     found from the catalog at run time (so a table added later is deleted
--     by default, which is the safe direction for personal data): clients
--     with no invoice, properties, dogs, subscriptions, visits and their
--     photos' rows, quotes, leads, messages, zones, expenses, time entries,
--     inventory, waste and DNA records, campaigns, notifications, imports,
--     webhooks, invites, user_roles (which is what ends everyone's access),
--     portal sessions, tokens and credentials, and so on. Their cascades go
--     with them.
--   NOT DONE HERE (the job's server half does it)
--     storage files under <org id>/ in visit-photos, waste-receipts,
--     dna-samples and expense-receipts; anonymising and signing out each
--     member's sign-in when they belong to no other organization.
--
-- ── SAFETY ────────────────────────────────────────────────────────────────
--
-- purge_locked_account refuses an organization that is not a candidate, one
-- that is not yet due, and any real run without a deploy date. Dry run is the
-- default. Both functions are service-role only.

-- ── SMS consent records, kept under their own retention ─────────────────

CREATE TABLE IF NOT EXISTS public.sms_consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign key: a consent record outlives the data it was taken with.
  organization_id uuid NOT NULL,
  subject text NOT NULL CHECK (subject IN ('account_holder', 'client')),
  subject_id uuid NOT NULL,
  phone text,
  consent_text text,
  consent_at timestamptz NOT NULL,
  source text,
  archived_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL,
  UNIQUE (subject, subject_id, consent_at)
);

COMMENT ON TABLE public.sms_consent_records IS
  'SMS consent (number, exact wording, time) copied out before an account''s data is deleted, '
  'and kept until retain_until under its own rule. The deletion job never deletes from here.';

ALTER TABLE public.sms_consent_records ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.sms_consent_records');
DROP POLICY IF EXISTS "platform admins read sms consent records" ON public.sms_consent_records;
CREATE POLICY "platform admins read sms consent records"
  ON public.sms_consent_records FOR SELECT TO authenticated
  USING (public.is_platform_admin((SELECT auth.uid())));
REVOKE INSERT, UPDATE, DELETE ON public.sms_consent_records FROM anon, authenticated;

-- ── The schedule the job keeps ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.account_deletion_schedule (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('trial_ended', 'plan_ended')),
  locked_since timestamptz NOT NULL,
  delete_after timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  purged_at timestamptz,
  last_report jsonb
);

ALTER TABLE public.account_deletion_schedule ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.account_deletion_schedule');
DROP POLICY IF EXISTS "platform admins read the deletion schedule" ON public.account_deletion_schedule;
CREATE POLICY "platform admins read the deletion schedule"
  ON public.account_deletion_schedule FOR SELECT TO authenticated
  USING (public.is_platform_admin((SELECT auth.uid())));
REVOKE INSERT, UPDATE, DELETE ON public.account_deletion_schedule FROM anon, authenticated;

-- ── Who is due, and when ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.account_deletion_candidates(
  _deployed_on date,
  _now timestamptz DEFAULT now()
)
RETURNS TABLE (organization_id uuid, reason text, locked_since timestamptz, delete_after timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH o AS (
    SELECT org.id,
           org.trial_ends_at,
           org.current_period_end,
           org.created_at,
           (org.plan_status::text = 'canceled' OR org.billing_status::text = 'canceled') AS cancelled,
           (org.plan_status::text IN ('active', 'past_due', 'grace')
             OR org.billing_status::text IN ('active', 'past_due', 'grace')) AS paying,
           org.stripe_subscription_id
      FROM public.organizations org
     WHERE NOT org.is_comped
       AND org.deleted_at IS NULL
       AND org.suspended_at IS NULL
       AND org.plan_status::text <> 'suspended'
       AND org.billing_status::text <> 'suspended'
  ), c AS (
    SELECT o.id,
           CASE
             WHEN o.cancelled THEN 'plan_ended'
             WHEN NOT o.paying AND o.stripe_subscription_id IS NULL
                  AND o.trial_ends_at IS NOT NULL AND o.trial_ends_at <= _now
                  AND o.created_at >= timestamptz '2026-08-16 00:00:00+00' THEN 'trial_ended'
           END AS reason,
           CASE
             WHEN o.cancelled THEN COALESCE(s.locked_since, o.current_period_end, _now)
             ELSE o.trial_ends_at
           END AS locked_since
      FROM o
      LEFT JOIN public.account_deletion_schedule s ON s.organization_id = o.id
     WHERE s.purged_at IS NULL
  )
  SELECT c.id, c.reason, c.locked_since,
         GREATEST(c.locked_since, _deployed_on::timestamptz) + interval '30 days'
    FROM c
   WHERE c.reason IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.account_deletion_candidates(date, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_candidates(date, timestamptz) TO service_role;

-- ── Count, or delete, one account ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_locked_account(
  _org uuid,
  _dry_run boolean DEFAULT true,
  _deployed_on date DEFAULT NULL,
  _now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _cand record;
  _t text;
  _n bigint;
  _delete jsonb := '{}'::jsonb;
  _keep jsonb := '{}'::jsonb;
  _clients_kept bigint;
  _clients_gone bigint;
  _consents bigint;
  -- Kept (anonymised or as is). Everything else with an organization_id goes.
  _kept_tables constant text[] := ARRAY[
    'invoices', 'payments', 'credit_ledger', 'clients', 'staff', 'activity_log',
    'platform_admin_audit', 'platform_invoices', 'org_platform_addons',
    'platform_support_notes', 'sms_consent_records', 'account_deletion_schedule'];
  -- SMS consent retention. Four years is the TCPA limitation period; the
  -- owner (with counsel) should confirm it. The job never deletes these rows.
  _retain constant interval := interval '4 years';
BEGIN
  SELECT * INTO _cand
    FROM public.account_deletion_candidates(_deployed_on, _now) c
   WHERE c.organization_id = _org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization % is not locked or cancelled; nothing may be deleted', _org;
  END IF;
  IF NOT _dry_run AND _deployed_on IS NULL THEN
    RAISE EXCEPTION 'no deploy date; refusing to delete';
  END IF;
  IF NOT _dry_run AND _cand.delete_after > _now THEN
    RAISE EXCEPTION 'organization % is not due until %', _org, _cand.delete_after;
  END IF;

  -- Count first, in both modes, from the catalog.
  FOR _t IN
    SELECT c.table_name::text
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'
     ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', _t) INTO _n USING _org;
    CONTINUE WHEN _n = 0;
    IF _t = ANY (_kept_tables) THEN
      _keep := _keep || jsonb_build_object(_t, _n);
    ELSE
      _delete := _delete || jsonb_build_object(_t, _n);
    END IF;
  END LOOP;

  SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.invoices i WHERE i.client_id = cl.id)),
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.client_id = cl.id))
    INTO _clients_kept, _clients_gone
    FROM public.clients cl WHERE cl.organization_id = _org;
  SELECT (SELECT count(*) FROM public.organizations WHERE id = _org AND sms_consent_at IS NOT NULL)
       + (SELECT count(*) FROM public.clients WHERE organization_id = _org AND sms_consent_at IS NOT NULL)
    INTO _consents;

  IF _dry_run THEN
    RETURN jsonb_build_object(
      'organization_id', _org,
      'dry_run', true,
      'reason', _cand.reason,
      'locked_since', _cand.locked_since,
      'delete_after', _cand.delete_after,
      'delete', _delete || jsonb_build_object('clients', _clients_gone),
      'keep', (_keep - 'clients') || jsonb_build_object('clients_with_invoices_anonymised', _clients_kept),
      'sms_consents_archived', _consents);
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  -- 1. SMS consent, out first, under its own retention.
  INSERT INTO public.sms_consent_records
         (organization_id, subject, subject_id, phone, consent_text, consent_at, source, retain_until)
  SELECT o.id, 'account_holder', o.id, o.sms_consent_phone, o.sms_consent_text, o.sms_consent_at,
         'organizations', o.sms_consent_at + _retain
    FROM public.organizations o
   WHERE o.id = _org AND o.sms_consent_at IS NOT NULL
  ON CONFLICT (subject, subject_id, consent_at) DO NOTHING;
  INSERT INTO public.sms_consent_records
         (organization_id, subject, subject_id, phone, consent_text, consent_at, source, retain_until)
  SELECT cl.organization_id, 'client', cl.id, cl.sms_consent_phone, cl.sms_consent_text, cl.sms_consent_at,
         cl.sms_consent_source, cl.sms_consent_at + _retain
    FROM public.clients cl
   WHERE cl.organization_id = _org AND cl.sms_consent_at IS NOT NULL
  ON CONFLICT (subject, subject_id, consent_at) DO NOTHING;

  -- 2. The audit trail survives the clients it mentions.
  UPDATE public.activity_log
     SET client_id = NULL, actor_label = NULL, summary = kind, meta = '{}'::jsonb
   WHERE organization_id = _org;
  UPDATE public.platform_admin_audit
     SET before_json = NULL, after_json = NULL
   WHERE organization_id = _org;

  -- 3. These two block a property's delete (no ON DELETE action).
  DELETE FROM public.addon_charges WHERE organization_id = _org;
  DELETE FROM public.addon_subscriptions WHERE organization_id = _org;

  -- 4. A client with no invoice goes, with everything that cascades from it.
  DELETE FROM public.clients cl
   WHERE cl.organization_id = _org
     AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.client_id = cl.id);

  -- 5. Every other organization-scoped row.
  FOR _t IN
    SELECT c.table_name::text
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'
     ORDER BY 1
  LOOP
    CONTINUE WHEN _t = ANY (_kept_tables);
    EXECUTE format('DELETE FROM public.%I WHERE organization_id = $1', _t) USING _org;
  END LOOP;

  -- 6. What is kept, anonymised.
  UPDATE public.clients
     SET display_name = 'Deleted client', first_name = NULL, last_name = NULL, company = NULL,
         primary_email = NULL, primary_phone = NULL, notes = NULL, referral_code = NULL,
         referral_source = NULL, churn_reason = NULL, autopay_last_error = NULL,
         default_payment_method_id = NULL, default_card_brand = NULL, default_card_last4 = NULL,
         preferred_contact = NULL, import_external_id = NULL, tags = '{}',
         sms_consent_phone = NULL, sms_consent_text = NULL, sms_consent_source = NULL,
         sms_consent_at = NULL
   WHERE organization_id = _org;
  UPDATE public.invoices SET notes = NULL, checkout_url = NULL WHERE organization_id = _org;
  UPDATE public.payments SET raw_event = NULL WHERE organization_id = _org;
  UPDATE public.staff
     SET active = false, display_name = 'Deleted user', email = NULL, phone = NULL, avatar_url = NULL,
         start_address = NULL, start_latitude = NULL, start_longitude = NULL,
         end_address = NULL, end_latitude = NULL, end_longitude = NULL
   WHERE organization_id = _org;
  UPDATE public.organizations
     SET name = 'Deleted account', contact_phone = NULL, contact_email = NULL, contact_address = NULL,
         latitude = NULL, longitude = NULL, digest_recipient_email = NULL, logo_url = NULL,
         google_review_url = NULL, review_ask_template = NULL, ai_receptionist_faq = NULL,
         ai_receptionist_persona = NULL, ai_voice_greeting = NULL, sms_from_number = NULL,
         sms_consent_phone = NULL, sms_consent_text = NULL, sms_consent_at = NULL,
         signup_utm = NULL, portal_slug = NULL, slug = NULL,
         deleted_at = COALESCE(deleted_at, _now)
   WHERE id = _org;

  UPDATE public.account_deletion_schedule
     SET purged_at = _now,
         last_report = jsonb_build_object(
           'deleted', _delete || jsonb_build_object('clients', _clients_gone),
           'kept', (_keep - 'clients') || jsonb_build_object('clients_with_invoices_anonymised', _clients_kept))
   WHERE organization_id = _org;

  RETURN jsonb_build_object(
    'organization_id', _org,
    'dry_run', false,
    'reason', _cand.reason,
    'delete_after', _cand.delete_after,
    'delete', _delete || jsonb_build_object('clients', _clients_gone),
    'keep', (_keep - 'clients') || jsonb_build_object('clients_with_invoices_anonymised', _clients_kept),
    'sms_consents_archived', _consents);
END;
$$;

REVOKE ALL ON FUNCTION public.purge_locked_account(uuid, boolean, date, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_locked_account(uuid, boolean, date, timestamptz) TO service_role;

DO $check$
BEGIN
  IF has_function_privilege('authenticated', 'public.purge_locked_account(uuid, boolean, date, timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.purge_locked_account(uuid, boolean, date, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'purge_locked_account is callable by a client role';
  END IF;
  IF has_function_privilege('authenticated', 'public.account_deletion_candidates(date, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'account_deletion_candidates is callable by authenticated';
  END IF;
  IF has_table_privilege('authenticated', 'public.sms_consent_records', 'DELETE')
     OR has_table_privilege('authenticated', 'public.account_deletion_schedule', 'INSERT') THEN
    RAISE EXCEPTION 'a client role can write the consent archive or the deletion schedule';
  END IF;
  -- The dry run is the default, and nothing in this file deletes a row.
  IF (SELECT pg_get_function_arguments('public.purge_locked_account(uuid, boolean, date, timestamptz)'::regprocedure))
     !~ '_dry_run boolean DEFAULT true' THEN
    RAISE EXCEPTION 'purge_locked_account no longer defaults to a dry run';
  END IF;
END
$check$;
