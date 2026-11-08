-- A portal change waits for the owner, when the owner says so (#730),
-- proved against a real Postgres. Run by
-- tests/a-portal-change-waits-for-the-owner.test.ts with :migration. One
-- transaction, ROLLED BACK at the end, the migration included. Each check
-- prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- Two businesses. A: an owner, an office manager, a client with a portal
-- token and four visits. B: an owner, a client, a visit. Staff are tried as
-- the API sees them (role authenticated, the JWT's sub set the way Supabase
-- sets it); the customer's calls run as the server does, with no user.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- Did the column exist before this run? On a database the migrations were
-- replayed into it already does, and the backfill cannot be watched.
CREATE TEMP TABLE proof_before (had_column boolean) ON COMMIT DROP;
INSERT INTO proof_before
SELECT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'organizations'
                  AND column_name = 'portal_change_policy');

SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0e000000-0000-4000-8000-000000073000', 'D6 Existing Before', 'UTC');
SET LOCAL app.allow_protected_org_write = '';

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-000000073001', 'owner-a@d6.proof.invalid'),
  ('f0000000-0000-4000-8000-000000073002', 'office-a@d6.proof.invalid'),
  ('f0000000-0000-4000-8000-000000073003', 'owner-b@d6.proof.invalid'),
  ('f0000000-0000-4000-8000-000000073004', 'tech-a@d6.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-000000073000', 'D6 Proof A', 'UTC'),
  ('0b000000-0000-4000-8000-000000073000', 'D6 Proof B', 'UTC');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-000000073001', '0a000000-0000-4000-8000-000000073000', 'owner'),
  ('f0000000-0000-4000-8000-000000073002', '0a000000-0000-4000-8000-000000073000', 'office_manager'),
  ('f0000000-0000-4000-8000-000000073003', '0b000000-0000-4000-8000-000000073000', 'owner'),
  ('f0000000-0000-4000-8000-000000073004', '0a000000-0000-4000-8000-000000073000', 'tech');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-000000073001', '0a000000-0000-4000-8000-000000073000', 'f0000000-0000-4000-8000-000000073001', 'owner', 'Owner A', true),
  ('5a000000-0000-4000-8000-000000073002', '0a000000-0000-4000-8000-000000073000', 'f0000000-0000-4000-8000-000000073002', 'office_manager', 'Office A', true),
  ('5b000000-0000-4000-8000-000000073003', '0b000000-0000-4000-8000-000000073000', 'f0000000-0000-4000-8000-000000073003', 'owner', 'Owner B', true),
  ('5a000000-0000-4000-8000-000000073004', '0a000000-0000-4000-8000-000000073000', 'f0000000-0000-4000-8000-000000073004', 'tech', 'Tech A', true);

INSERT INTO public.clients (id, organization_id, account_type, display_name, portal_token) VALUES
  ('c0000000-0000-4000-8000-0000000730a1', '0a000000-0000-4000-8000-000000073000', 'residential', 'D6 Client A', 'aaaaaaaa-0000-4000-8000-0000000730a1'),
  ('c0000000-0000-4000-8000-0000000730b1', '0b000000-0000-4000-8000-000000073000', 'residential', 'D6 Client B', 'bbbbbbbb-0000-4000-8000-0000000730b1');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('d0000000-0000-4000-8000-0000000730a1', '0a000000-0000-4000-8000-000000073000', 'c0000000-0000-4000-8000-0000000730a1', '1 Oak St', 'Springfield', '60614'),
  ('d0000000-0000-4000-8000-0000000730b1', '0b000000-0000-4000-8000-000000073000', 'c0000000-0000-4000-8000-0000000730b1', '9 Elm St', 'Shelbyville', '60615');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on) VALUES
  ('e0000000-0000-4000-8000-0000000730a1', '0a000000-0000-4000-8000-000000073000', 'c0000000-0000-4000-8000-0000000730a1', 'd0000000-0000-4000-8000-0000000730a1', 'residential', 'weekly', 2400, 1, current_date),
  ('e0000000-0000-4000-8000-0000000730b1', '0b000000-0000-4000-8000-000000073000', 'c0000000-0000-4000-8000-0000000730b1', 'd0000000-0000-4000-8000-0000000730b1', 'residential', 'weekly', 2400, 1, current_date);

-- Visits 10, 11, 12, 13 and 5 days out for A, 10 for B: every one is well
-- before the default 18-hour cutoff.
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, assigned_staff_id, status)
SELECT v.id::uuid, '0a000000-0000-4000-8000-000000073000', 'e0000000-0000-4000-8000-0000000730a1',
       'c0000000-0000-4000-8000-0000000730a1', 'd0000000-0000-4000-8000-0000000730a1',
       current_date + v.off, '5a000000-0000-4000-8000-000000073004', 'scheduled'
  FROM (VALUES ('7a000000-0000-4000-8000-000000073001', 10),
               ('7a000000-0000-4000-8000-000000073002', 11),
               ('7a000000-0000-4000-8000-000000073003', 12),
               ('7a000000-0000-4000-8000-000000073004', 13),
               -- Inside two weeks, for the per-line cutoff at the end.
               ('7a000000-0000-4000-8000-000000073005', 5)) AS v(id, off);
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, status)
VALUES ('7b000000-0000-4000-8000-000000073001', '0b000000-0000-4000-8000-000000073000', 'e0000000-0000-4000-8000-0000000730b1',
        'c0000000-0000-4000-8000-0000000730b1', 'd0000000-0000-4000-8000-0000000730b1', current_date + 10, 'scheduled');

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;
CREATE FUNCTION pg_temp.as_server() RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', '', true);
$$;
-- A refusal counts only when it is THIS change's refusal: an owner check, or
-- the missing write grant on a portal change table. Anything else with the
-- same SQLSTATE (a fixture the caller cannot read) is a broken proof.
CREATE FUNCTION pg_temp.refused_for_the_right_reason(_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF _msg NOT LIKE 'Only an owner%' AND _msg NOT LIKE 'permission denied for table portal\_change\_%' THEN
    RAISE EXCEPTION 'PROOF FAILED [refusal]: refused for the wrong reason: %', _msg;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.refused_for_the_right_reason(text) TO authenticated;

-- ── 1. Defaults ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT portal_change_policy FROM public.organizations WHERE id = '0a000000-0000-4000-8000-000000073000') <> 'approval'
     OR (SELECT portal_change_fees_autocharge FROM public.organizations WHERE id = '0a000000-0000-4000-8000-000000073000') THEN
    RAISE EXCEPTION 'PROOF FAILED [defaults]: a new business does not start on approval with auto-charge off';
  END IF;
  IF (SELECT had_column FROM proof_before) THEN
    RAISE WARNING 'SKIPPED [backfill]: the column already existed before this run, so the existing-business backfill could not be watched here';
  ELSIF (SELECT portal_change_policy FROM public.organizations WHERE id = '0e000000-0000-4000-8000-000000073000') <> 'instant' THEN
    RAISE EXCEPTION 'PROOF FAILED [backfill]: a business that existed before the migration did not keep instant';
  ELSE
    RAISE NOTICE 'ok: a business that existed before the migration keeps instant';
  END IF;
  RAISE NOTICE 'ok: a new business starts on approval, with automatic fee charging off';
END $$;

-- ── 2. Only an owner of THIS business changes the setting ───────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073002');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.set_portal_change_settings('0a000000-0000-4000-8000-000000073000', 'instant', NULL, NULL);
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: the office manager changed the policy';
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.refused_for_the_right_reason(SQLERRM);
  END;
  BEGIN
    UPDATE public.organizations SET portal_change_policy = 'instant' WHERE id = '0a000000-0000-4000-8000-000000073000';
    IF FOUND THEN
      RAISE EXCEPTION 'PROOF FAILED [om rest]: a direct UPDATE changed the policy';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.refused_for_the_right_reason(SQLERRM);
  END;
  BEGIN
    UPDATE public.organizations SET portal_change_fees_autocharge = true WHERE id = '0a000000-0000-4000-8000-000000073000';
    IF FOUND THEN
      RAISE EXCEPTION 'PROOF FAILED [om rest]: a direct UPDATE turned automatic charging on';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.refused_for_the_right_reason(SQLERRM);
  END;
  BEGIN
    INSERT INTO public.portal_change_rules (organization_id, service_line, late_window_hours, late_cancel_fee_cents)
    VALUES ('0a000000-0000-4000-8000-000000073000', 'pet_waste', 48, 2500);
    RAISE EXCEPTION 'PROOF FAILED [om rest]: the office manager wrote a fee rule directly';
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.refused_for_the_right_reason(SQLERRM);
  END;
  RAISE NOTICE 'ok: an office manager cannot change the policy, the auto-charge switch or a fee rule, by RPC or REST';
END $$;
RESET ROLE;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073003');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.set_portal_change_settings('0a000000-0000-4000-8000-000000073000', 'instant', true, NULL);
    RAISE EXCEPTION 'PROOF FAILED [cross-tenant]: business B''s owner changed business A''s policy';
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.refused_for_the_right_reason(SQLERRM);
  END;
  UPDATE public.organizations SET portal_change_policy = 'instant' WHERE id = '0a000000-0000-4000-8000-000000073000';
  RAISE NOTICE 'ok: another business''s owner cannot change this business''s policy';
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM pg_temp.refused_for_the_right_reason(SQLERRM);
  RAISE NOTICE 'ok: another business''s owner cannot change this business''s policy';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT portal_change_policy FROM public.organizations WHERE id = '0a000000-0000-4000-8000-000000073000') <> 'approval'
     OR (SELECT portal_change_fees_autocharge FROM public.organizations WHERE id = '0a000000-0000-4000-8000-000000073000')
     OR EXISTS (SELECT 1 FROM public.portal_change_rules WHERE organization_id = '0a000000-0000-4000-8000-000000073000')
     OR EXISTS (SELECT 1 FROM public.activity_log WHERE organization_id = '0a000000-0000-4000-8000-000000073000') THEN
    RAISE EXCEPTION 'PROOF FAILED [after refusals]: a refused write changed or logged something';
  END IF;
  RAISE NOTICE 'ok: nothing a refused caller tried changed a row or wrote a log line';
END $$;

-- The owner sets INSTANT, and it is logged with their name.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073001');
SET LOCAL ROLE authenticated;
SELECT public.set_portal_change_settings('0a000000-0000-4000-8000-000000073000', 'instant', NULL, NULL);
RESET ROLE;

DO $$
BEGIN
  IF (SELECT portal_change_policy FROM public.organizations WHERE id = '0a000000-0000-4000-8000-000000073000') <> 'instant' THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: the owner''s choice did not land';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.activity_log
                  WHERE organization_id = '0a000000-0000-4000-8000-000000073000'
                    AND kind = 'org.portal_change_policy_changed'
                    AND actor_user_id = 'f0000000-0000-4000-8000-000000073001'
                    AND actor_label = 'Owner A'
                    AND meta->>'from' = 'approval' AND meta->>'to' = 'instant') THEN
    RAISE EXCEPTION 'PROOF FAILED [owner log]: the policy change is not logged with the owner, from and to';
  END IF;
  RAISE NOTICE 'ok: the owner chooses instant, and the change names the owner, from and to';
END $$;

-- ── 3. INSTANT: the change is applied when the customer asks ────────────────
SELECT pg_temp.as_server();
DO $$
DECLARE _r jsonb; _v record;
BEGIN
  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073001', 'reschedule', current_date + 20, 'away', NULL);
  IF _r->>'status' <> 'applied' THEN
    RAISE EXCEPTION 'PROOF FAILED [instant]: reschedule came back %', _r;
  END IF;
  SELECT scheduled_on, assigned_staff_id, status INTO _v FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073001';
  IF _v.scheduled_on <> current_date + 20 OR _v.assigned_staff_id IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [instant]: the visit was not moved and unassigned (%)', _v;
  END IF;

  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073002', 'cancel', NULL, 'party', NULL);
  IF _r->>'status' <> 'applied'
     OR (SELECT status FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073002') <> 'skipped'
     OR (SELECT skip_reason_code FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073002') <> 'customer_requested' THEN
    RAISE EXCEPTION 'PROOF FAILED [instant]: cancel did not skip the visit (%)', _r;
  END IF;

  IF (SELECT count(*) FROM public.activity_log
       WHERE organization_id = '0a000000-0000-4000-8000-000000073000'
         AND kind IN ('portal_change.requested', 'portal_change.applied')
         AND actor_user_id IS NULL AND actor_label = 'Customer (portal)') <> 4 THEN
    RAISE EXCEPTION 'PROOF FAILED [instant log]: expected a requested and an applied line for each change';
  END IF;
  RAISE NOTICE 'ok: INSTANT applies a reschedule and a cancel at once, and logs both';
END $$;

-- ── 4. APPROVAL: the change waits, and only A's owner answers ───────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073001');
SET LOCAL ROLE authenticated;
SELECT public.set_portal_change_settings('0a000000-0000-4000-8000-000000073000', 'approval', NULL, NULL);
RESET ROLE;

SELECT pg_temp.as_server();
CREATE TEMP TABLE proof_req (k text PRIMARY KEY, id uuid) ON COMMIT DROP;
-- Staff read it below. Without this grant every refusal would be "permission
-- denied for table proof_req", the same SQLSTATE as the refusal being proved.
GRANT SELECT ON proof_req TO authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073003', 'reschedule', current_date + 25, NULL, NULL);
  IF _r->>'status' <> 'pending' THEN
    RAISE EXCEPTION 'PROOF FAILED [approval]: reschedule came back %', _r;
  END IF;
  INSERT INTO proof_req VALUES ('resched', (_r->>'request_id')::uuid);
  IF (SELECT scheduled_on FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073003') <> current_date + 12 THEN
    RAISE EXCEPTION 'PROOF FAILED [approval]: a pending reschedule moved the visit';
  END IF;

  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7a000000-0000-4000-8000-000000073003', 'cancel', NULL, NULL, NULL);
    RAISE EXCEPTION 'PROOF FAILED [approval]: a second request on a waiting visit was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'A change to this visit is already waiting%' THEN RAISE; END IF;
  END;

  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073004', 'cancel', NULL, NULL, NULL);
  INSERT INTO proof_req VALUES ('cancel', (_r->>'request_id')::uuid);
  IF (SELECT status FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073004') <> 'scheduled' THEN
    RAISE EXCEPTION 'PROOF FAILED [approval]: a pending cancel skipped the visit';
  END IF;

  -- Cross-tenant from the portal: A's token, B's visit.
  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7b000000-0000-4000-8000-000000073001', 'cancel', NULL, NULL, NULL);
    RAISE EXCEPTION 'PROOF FAILED [cross-tenant portal]: A''s customer asked about B''s visit';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Visit not eligible%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: APPROVAL holds a reschedule and a cancel without touching the visit, one at a time, own visits only';
END $$;

-- The office manager, B's owner and a technician are refused.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073002');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.decide_portal_change_request((SELECT id FROM proof_req WHERE k = 'resched'), true, NULL);
  RAISE EXCEPTION 'PROOF FAILED [om decide]: the office manager approved a change';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.refused_for_the_right_reason(SQLERRM);
END $$;
DO $$
BEGIN
  -- But they can see the queue.
  IF (SELECT count(*) FROM public.portal_change_requests WHERE organization_id = '0a000000-0000-4000-8000-000000073000') < 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [om read]: the office manager cannot see the queue';
  END IF;
END $$;
RESET ROLE;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073003');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.decide_portal_change_request((SELECT id FROM proof_req WHERE k = 'resched'), true, NULL);
    RAISE EXCEPTION 'PROOF FAILED [cross-tenant decide]: business B''s owner approved A''s change';
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.refused_for_the_right_reason(SQLERRM);
  END;
  IF EXISTS (SELECT 1 FROM public.portal_change_requests WHERE organization_id = '0a000000-0000-4000-8000-000000073000') THEN
    RAISE EXCEPTION 'PROOF FAILED [cross-tenant read]: business B''s owner can read A''s requests';
  END IF;
END $$;
RESET ROLE;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073004');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.decide_portal_change_request((SELECT id FROM proof_req WHERE k = 'cancel'), false, NULL);
    RAISE EXCEPTION 'PROOF FAILED [tech decide]: a technician denied a change';
  EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.refused_for_the_right_reason(SQLERRM);
  END;
  IF EXISTS (SELECT 1 FROM public.portal_change_requests) THEN
    RAISE EXCEPTION 'PROOF FAILED [tech read]: a technician can read the queue';
  END IF;
  RAISE NOTICE 'ok: the office manager sees but cannot answer; another business''s owner and a technician can do neither';
END $$;
RESET ROLE;

-- A's owner approves one and denies the other.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073001');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := public.decide_portal_change_request((SELECT id FROM proof_req WHERE k = 'resched'), true, 'ok');
  IF _r->>'status' <> 'approved' THEN RAISE EXCEPTION 'PROOF FAILED [approve]: %', _r; END IF;
  _r := public.decide_portal_change_request((SELECT id FROM proof_req WHERE k = 'cancel'), false, 'we need this one');
  IF _r->>'status' <> 'denied' THEN RAISE EXCEPTION 'PROOF FAILED [deny]: %', _r; END IF;
  BEGIN
    PERFORM public.decide_portal_change_request((SELECT id FROM proof_req WHERE k = 'cancel'), true, NULL);
    RAISE EXCEPTION 'PROOF FAILED [twice]: an answered request was answered again';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'This request has already been answered%' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT scheduled_on FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073003') <> current_date + 25 THEN
    RAISE EXCEPTION 'PROOF FAILED [approve]: approval did not move the visit';
  END IF;
  IF (SELECT status FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073004') <> 'scheduled' THEN
    RAISE EXCEPTION 'PROOF FAILED [deny]: denial changed the visit';
  END IF;
  IF (SELECT count(*) FROM public.activity_log
       WHERE organization_id = '0a000000-0000-4000-8000-000000073000'
         AND kind IN ('portal_change.approved', 'portal_change.denied')
         AND actor_user_id = 'f0000000-0000-4000-8000-000000073001') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [decide log]: approve and deny are not each logged with the owner';
  END IF;
  RAISE NOTICE 'ok: the owner''s approval applies the change, a denial leaves the visit, and each is logged';
END $$;

-- The customer withdraws a waiting request; another business's customer cannot.
SELECT pg_temp.as_server();
DO $$
DECLARE _r jsonb;
BEGIN
  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073004', 'cancel', NULL, NULL, NULL);
  BEGIN
    PERFORM public.portal_withdraw_change_request('bbbbbbbb-0000-4000-8000-0000000730b1', (_r->>'request_id')::uuid);
    RAISE EXCEPTION 'PROOF FAILED [withdraw cross-tenant]: B''s customer withdrew A''s request';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Request not found%' THEN RAISE; END IF;
  END;
  PERFORM public.portal_withdraw_change_request('aaaaaaaa-0000-4000-8000-0000000730a1', (_r->>'request_id')::uuid);
  IF (SELECT status FROM public.portal_change_requests WHERE id = (_r->>'request_id')::uuid) <> 'withdrawn'
     OR NOT EXISTS (SELECT 1 FROM public.activity_log WHERE kind = 'portal_change.withdrawn'
                     AND meta->>'request_id' = _r->>'request_id') THEN
    RAISE EXCEPTION 'PROOF FAILED [withdraw]: the request was not withdrawn and logged';
  END IF;
  RAISE NOTICE 'ok: a customer withdraws their own waiting request, and only their own';
END $$;

-- ── 5. Cutoffs and fees, per line ───────────────────────────────────────────
-- Pet waste: no hard cutoff before the visit day, a late window that is
-- already open for every fixture visit, and a cancel fee.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073001');
SET LOCAL ROLE authenticated;
SELECT public.set_portal_change_settings('0a000000-0000-4000-8000-000000073000', NULL, NULL,
  '[{"service_line":"pet_waste","cutoff_hours":0,"late_window_hours":336,"late_reschedule_fee_cents":0,"late_cancel_fee_cents":1500}]'::jsonb);
RESET ROLE;

SELECT pg_temp.as_server();
DO $$
DECLARE _r jsonb; _c jsonb; _c2 jsonb; _t record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.activity_log WHERE kind = 'org.portal_change_rules_changed'
                  AND organization_id = '0a000000-0000-4000-8000-000000073000'
                  AND actor_user_id = 'f0000000-0000-4000-8000-000000073001') THEN
    RAISE EXCEPTION 'PROOF FAILED [rules log]: the rule change is not logged with the owner';
  END IF;

  SELECT * INTO _t FROM public.portal_visit_change_terms('aaaaaaaa-0000-4000-8000-0000000730a1')
   WHERE visit_id = '7a000000-0000-4000-8000-000000073004';
  IF _t.cancel_fee_cents <> 1500 OR _t.late_from IS NULL OR _t.late_from > now() OR _t.policy <> 'approval'
     OR _t.pending_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [terms]: the portal is not told the fee before it applies (%)', _t;
  END IF;

  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7a000000-0000-4000-8000-000000073004', 'cancel', NULL, NULL, NULL);
    RAISE EXCEPTION 'PROOF FAILED [fee]: a late cancel was accepted without the fee being accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'FEE_NOT_ACCEPTED%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7a000000-0000-4000-8000-000000073004', 'cancel', NULL, NULL, 1);
    RAISE EXCEPTION 'PROOF FAILED [fee]: a late cancel was accepted at a figure the customer typed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'FEE_NOT_ACCEPTED%' THEN RAISE; END IF;
  END;

  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073004', 'cancel', NULL, NULL, 1500);
  IF (_r->>'fee_cents')::int <> 1500 OR _r->>'status' <> 'pending' THEN
    RAISE EXCEPTION 'PROOF FAILED [fee]: %', _r;
  END IF;
  INSERT INTO proof_req VALUES ('fee', (_r->>'request_id')::uuid);

  -- A pending request carries no charge.
  BEGIN
    PERFORM public.begin_portal_change_fee((_r->>'request_id')::uuid);
    RAISE EXCEPTION 'PROOF FAILED [fee]: a fee was begun for a request nobody approved';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Only an applied or approved change carries a fee%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: the fee is shown before it applies, and a late change is refused unless the shown fee is accepted';
END $$;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073001');
SET LOCAL ROLE authenticated;
SELECT public.decide_portal_change_request((SELECT id FROM proof_req WHERE k = 'fee'), true, NULL);
RESET ROLE;

SELECT pg_temp.as_server();
DO $$
DECLARE _c jsonb; _c2 jsonb; _id uuid; _out text;
BEGIN
  _c := public.begin_portal_change_fee((SELECT id FROM proof_req WHERE k = 'fee'));
  _c2 := public.begin_portal_change_fee((SELECT id FROM proof_req WHERE k = 'fee'));
  IF NOT (_c->>'created')::boolean OR (_c2->>'created')::boolean
     OR _c->'charge'->>'id' <> _c2->'charge'->>'id'
     OR (_c->'charge'->>'amount_cents')::int <> 1500
     OR _c->'charge'->>'idempotency_key' <> 'portal-change-fee:' || (SELECT id FROM proof_req WHERE k = 'fee') THEN
    RAISE EXCEPTION 'PROOF FAILED [fee once]: % / %', _c, _c2;
  END IF;
  _id := (_c->'charge'->>'id')::uuid;

  PERFORM public.note_portal_change_fee_attempt(_id, 'processing', 'pi_test_d6', 'acct_test_a', NULL, false);
  BEGIN
    PERFORM public.note_portal_change_fee_attempt(_id, 'succeeded', 'pi_test_d6', 'acct_test_a', NULL, false);
    RAISE EXCEPTION 'PROOF FAILED [fee]: the server marked a fee succeeded without a webhook';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'A fee attempt cannot be recorded as%' THEN RAISE; END IF;
  END;

  _out := public.record_portal_change_fee_event('evt_d6_1', 'payment_intent.succeeded', 'pi_test_d6', 'acct_test_b', true, NULL, false);
  IF _out <> 'unknown' THEN
    RAISE EXCEPTION 'PROOF FAILED [webhook tenant]: another account''s event settled the fee (%)', _out;
  END IF;
  _out := public.record_portal_change_fee_event('evt_d6_1', 'payment_intent.succeeded', 'pi_test_d6', 'acct_test_a', true, NULL, false);
  IF _out <> 'succeeded' THEN RAISE EXCEPTION 'PROOF FAILED [webhook]: %', _out; END IF;
  _out := public.record_portal_change_fee_event('evt_d6_1', 'payment_intent.succeeded', 'pi_test_d6', 'acct_test_a', true, NULL, false);
  IF _out <> 'duplicate' THEN RAISE EXCEPTION 'PROOF FAILED [webhook duplicate]: %', _out; END IF;
  _out := public.record_portal_change_fee_event('evt_d6_2', 'payment_intent.payment_failed', 'pi_test_d6', 'acct_test_a', false, 'late', false);
  IF _out <> 'unchanged' OR (SELECT status FROM public.portal_change_fee_charges WHERE id = _id) <> 'succeeded' THEN
    RAISE EXCEPTION 'PROOF FAILED [webhook order]: a late failure undid a success (%)', _out;
  END IF;
  IF (SELECT count(*) FROM public.activity_log WHERE kind = 'portal_change_fee.charged'
       AND meta->>'charge_id' = _id::text) <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [webhook log]: the charge is not logged exactly once';
  END IF;
  RAISE NOTICE 'ok: one charge per request, success only from a webhook of the right account, a duplicate delivery changes nothing';
END $$;

-- A hard cutoff per line: two weeks before the visit day puts the visit five
-- days out past it.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073001');
SET LOCAL ROLE authenticated;
SELECT public.set_portal_change_settings('0a000000-0000-4000-8000-000000073000', 'instant', NULL,
  '[{"service_line":"pet_waste","cutoff_hours":336,"late_window_hours":null,"late_reschedule_fee_cents":0,"late_cancel_fee_cents":0}]'::jsonb);
RESET ROLE;

SELECT pg_temp.as_server();
DO $$
BEGIN
  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7a000000-0000-4000-8000-000000073005', 'cancel', NULL, NULL, NULL);
    RAISE EXCEPTION 'PROOF FAILED [line cutoff]: a change past the line''s cutoff was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'This visit is past the change cutoff%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: a per-line cutoff is enforced on the server';
END $$;

ROLLBACK;
\echo ALL PORTAL-CHANGE-WAITS-FOR-THE-OWNER PROOFS PASSED
