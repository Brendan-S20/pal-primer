-- A portal change waits for the owner, when the owner says so (#730),
-- proved against a real Postgres. Run by
-- tests/a-portal-change-waits-for-the-owner.test.ts with :migration. One
-- transaction, ROLLED BACK at the end, the migration included. Each check
-- prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- Two businesses. A: an owner, an office manager, a client with a portal
-- token and its visits. B: an owner, a client, a visit. Staff are tried as
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

-- Run by the vitest file, the migration is applied here inside this
-- transaction. Run by CI's database job (supabase/proofs/), the database was
-- just built from every migration and there is nothing to apply.
\if :{?migration}
\i :migration
\endif

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
               ('7a000000-0000-4000-8000-000000073005', 5),
               -- For the review's findings (sections 6 to 8).
               ('7a000000-0000-4000-8000-000000073006', 6),
               ('7a000000-0000-4000-8000-000000073007', 7),
               ('7a000000-0000-4000-8000-000000073008', 8),
               ('7a000000-0000-4000-8000-000000073009', 9),
               -- Outside the 14-day late window (section 6, the inverse).
               ('7a000000-0000-4000-8000-000000073010', 35)) AS v(id, off);
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
          '7a000000-0000-4000-8000-000000073001', 'reschedule', current_date + 20, 'away', NULL, gen_random_uuid()::text);
  IF _r->>'status' <> 'applied' THEN
    RAISE EXCEPTION 'PROOF FAILED [instant]: reschedule came back %', _r;
  END IF;
  SELECT scheduled_on, assigned_staff_id, status INTO _v FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073001';
  IF _v.scheduled_on <> current_date + 20 OR _v.assigned_staff_id IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [instant]: the visit was not moved and unassigned (%)', _v;
  END IF;

  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073002', 'cancel', NULL, 'party', NULL, gen_random_uuid()::text);
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
          '7a000000-0000-4000-8000-000000073003', 'reschedule', current_date + 25, NULL, NULL, gen_random_uuid()::text);
  IF _r->>'status' <> 'pending' THEN
    RAISE EXCEPTION 'PROOF FAILED [approval]: reschedule came back %', _r;
  END IF;
  INSERT INTO proof_req VALUES ('resched', (_r->>'request_id')::uuid);
  IF (SELECT scheduled_on FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073003') <> current_date + 12 THEN
    RAISE EXCEPTION 'PROOF FAILED [approval]: a pending reschedule moved the visit';
  END IF;

  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7a000000-0000-4000-8000-000000073003', 'cancel', NULL, NULL, NULL, gen_random_uuid()::text);
    RAISE EXCEPTION 'PROOF FAILED [approval]: a second request on a waiting visit was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'A change to this visit is already waiting%' THEN RAISE; END IF;
  END;

  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073004', 'cancel', NULL, NULL, NULL, gen_random_uuid()::text);
  INSERT INTO proof_req VALUES ('cancel', (_r->>'request_id')::uuid);
  IF (SELECT status FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073004') <> 'scheduled' THEN
    RAISE EXCEPTION 'PROOF FAILED [approval]: a pending cancel skipped the visit';
  END IF;

  -- Cross-tenant from the portal: A's token, B's visit.
  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7b000000-0000-4000-8000-000000073001', 'cancel', NULL, NULL, NULL, gen_random_uuid()::text);
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
          '7a000000-0000-4000-8000-000000073004', 'cancel', NULL, NULL, NULL, gen_random_uuid()::text);
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
              '7a000000-0000-4000-8000-000000073004', 'cancel', NULL, NULL, NULL, gen_random_uuid()::text);
    RAISE EXCEPTION 'PROOF FAILED [fee]: a late cancel was accepted without the fee being accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'FEE_NOT_ACCEPTED%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7a000000-0000-4000-8000-000000073004', 'cancel', NULL, NULL, 1, gen_random_uuid()::text);
    RAISE EXCEPTION 'PROOF FAILED [fee]: a late cancel was accepted at a figure the customer typed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'FEE_NOT_ACCEPTED%' THEN RAISE; END IF;
  END;

  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073004', 'cancel', NULL, NULL, 1500, gen_random_uuid()::text);
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

  _out := public.record_portal_change_fee_event('evt_d6_1', 'payment_intent.succeeded', 'pi_test_d6', 'acct_test_b', true, NULL, false, NULL);
  IF _out <> 'unknown' THEN
    RAISE EXCEPTION 'PROOF FAILED [webhook tenant]: another account''s event settled the fee (%)', _out;
  END IF;
  _out := public.record_portal_change_fee_event('evt_d6_1', 'payment_intent.succeeded', 'pi_test_d6', 'acct_test_a', true, NULL, false, NULL);
  IF _out <> 'succeeded' THEN RAISE EXCEPTION 'PROOF FAILED [webhook]: %', _out; END IF;
  _out := public.record_portal_change_fee_event('evt_d6_1', 'payment_intent.succeeded', 'pi_test_d6', 'acct_test_a', true, NULL, false, NULL);
  IF _out <> 'duplicate' THEN RAISE EXCEPTION 'PROOF FAILED [webhook duplicate]: %', _out; END IF;
  _out := public.record_portal_change_fee_event('evt_d6_2', 'payment_intent.payment_failed', 'pi_test_d6', 'acct_test_a', false, 'late', false, NULL);
  IF _out <> 'unchanged' OR (SELECT status FROM public.portal_change_fee_charges WHERE id = _id) <> 'succeeded' THEN
    RAISE EXCEPTION 'PROOF FAILED [webhook order]: a late failure undid a success (%)', _out;
  END IF;
  IF (SELECT count(*) FROM public.activity_log WHERE kind = 'portal_change_fee.charged'
       AND meta->>'charge_id' = _id::text) <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [webhook log]: the charge is not logged exactly once';
  END IF;
  RAISE NOTICE 'ok: one charge per request, success only from a webhook of the right account, a duplicate delivery changes nothing';
END $$;


-- ── 6. One press, one request, one fee (review finding 1) ───────────────────
-- INSTANT, with a late reschedule fee open for every fixture visit.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073001');
SET LOCAL ROLE authenticated;
SELECT public.set_portal_change_settings('0a000000-0000-4000-8000-000000073000', 'instant', NULL,
  '[{"service_line":"pet_waste","cutoff_hours":0,"late_window_hours":336,"late_reschedule_fee_cents":1000,"late_cancel_fee_cents":1500}]'::jsonb);
RESET ROLE;

SELECT pg_temp.as_server();
DO $$
DECLARE _r1 jsonb; _r2 jsonb; _n int;
BEGIN
  _r1 := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
           '7a000000-0000-4000-8000-000000073006', 'reschedule', current_date + 30, NULL, 1000, 'press-0006-a');
  BEGIN
    _r2 := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
             '7a000000-0000-4000-8000-000000073006', 'reschedule', current_date + 30, NULL, 1000, 'press-0006-a');
  EXCEPTION WHEN raise_exception THEN
    RAISE EXCEPTION 'PROOF FAILED [repeat key]: a retried press was refused instead of given its first answer: %', SQLERRM;
  END;
  IF _r1->>'status' <> 'applied' OR _r2->>'request_id' <> _r1->>'request_id'
     OR NOT COALESCE((_r2->>'replayed')::boolean, false) THEN
    RAISE EXCEPTION 'PROOF FAILED [repeat key]: a retried press was not given its first answer (% / %)', _r1, _r2;
  END IF;

  -- The same change with a NEW key (a second tab): the visit is already there.
  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7a000000-0000-4000-8000-000000073006', 'reschedule', current_date + 30, NULL, 1000, 'press-0006-b');
    RAISE EXCEPTION 'PROOF FAILED [same date]: moving a visit to the day it is on made a second request';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'This visit is already on that date%' THEN RAISE; END IF;
  END;

  -- A key cannot be reused for a different change.
  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7a000000-0000-4000-8000-000000073006', 'reschedule', current_date + 31, NULL, 1000, 'press-0006-a');
    RAISE EXCEPTION 'PROOF FAILED [key reuse]: one key carried two different changes';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'This request key was already used for a different change%' THEN RAISE; END IF;
  END;

  -- A cancel pressed twice with a new key: the visit is already skipped.
  PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
            '7a000000-0000-4000-8000-000000073007', 'cancel', NULL, NULL, 1500, 'press-0007-a');
  BEGIN
    PERFORM public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
              '7a000000-0000-4000-8000-000000073007', 'cancel', NULL, NULL, 1500, 'press-0007-b');
    RAISE EXCEPTION 'PROOF FAILED [double cancel]: a skipped visit was skipped again';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Visit not eligible to skip%' THEN RAISE; END IF;
  END;

  -- The unique index is the backstop if two presses ever got past the lock.
  BEGIN
    INSERT INTO public.portal_change_requests (organization_id, client_id, visit_id, kind, original_date,
      policy, status, service_line, idempotency_key)
    VALUES ('0a000000-0000-4000-8000-000000073000', 'c0000000-0000-4000-8000-0000000730a1',
      '7a000000-0000-4000-8000-000000073007', 'cancel', current_date + 7, 'instant', 'applied', 'pet_waste', 'press-0007-a');
    RAISE EXCEPTION 'PROOF FAILED [key index]: a second request with the same key was stored';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  SELECT count(*) INTO _n FROM public.portal_change_requests
   WHERE visit_id IN ('7a000000-0000-4000-8000-000000073006', '7a000000-0000-4000-8000-000000073007');
  IF _n <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [one request each]: expected 2 requests for two presses, found %', _n;
  END IF;
  PERFORM public.begin_portal_change_fee((_r1->>'request_id')::uuid);
  PERFORM public.begin_portal_change_fee((_r1->>'request_id')::uuid);
  SELECT count(*) INTO _n FROM public.portal_change_fee_charges c
    JOIN public.portal_change_requests r ON r.id = c.request_id
   WHERE r.visit_id = '7a000000-0000-4000-8000-000000073006';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [one fee]: expected 1 fee for the moved visit, found %', _n;
  END IF;
  -- The fee asserted, not assumed: the moved visit was +6, inside the window.
  IF (SELECT fee_cents FROM public.portal_change_requests WHERE id = (_r1->>'request_id')::uuid) <> 1000
     OR (SELECT amount_cents FROM public.portal_change_fee_charges WHERE request_id = (_r1->>'request_id')::uuid) <> 1000 THEN
    RAISE EXCEPTION 'PROOF FAILED [fee in window]: the change inside the window does not carry the rule''s 1000';
  END IF;
  RAISE NOTICE 'ok: a repeated press returns its first answer, the same change again is refused, and one change carries one fee';
END $$;

-- The inverse (re-review of 394fd5a): a visit 35 days out is outside the
-- 336-hour window, so its change carries no fee and no fee row is made.
DO $$
DECLARE _r jsonb; _c jsonb;
BEGIN
  BEGIN
    _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
            '7a000000-0000-4000-8000-000000073010', 'reschedule', current_date + 36, NULL, NULL, 'press-0010-a');
  EXCEPTION WHEN raise_exception THEN
    RAISE EXCEPTION 'PROOF FAILED [outside window]: a change outside the late window was refused: %', SQLERRM;
  END;
  IF _r->>'status' <> 'applied' OR (_r->>'fee_cents')::int <> 0
     OR (SELECT fee_cents FROM public.portal_change_requests WHERE id = (_r->>'request_id')::uuid) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [outside window]: a change outside the late window carried a fee (%)', _r;
  END IF;
  _c := public.begin_portal_change_fee((_r->>'request_id')::uuid);
  IF _c IS DISTINCT FROM jsonb_build_object('charge', NULL, 'created', false)
     OR EXISTS (SELECT 1 FROM public.portal_change_fee_charges WHERE request_id = (_r->>'request_id')::uuid) THEN
    RAISE EXCEPTION 'PROOF FAILED [outside window]: a fee row was made for a change with no fee (%)', _c;
  END IF;
  RAISE NOTICE 'ok: a change outside the late window carries no fee, and beginning a fee for it makes none';
END $$;

-- ── 7. A webhook that beats the server's response (review finding 2) ──────
SELECT pg_temp.as_server();
DO $$
DECLARE _req uuid; _c jsonb; _id uuid; _out text;
BEGIN
  SELECT id INTO _req FROM public.portal_change_requests
   WHERE visit_id = '7a000000-0000-4000-8000-000000073007' AND status = 'applied';
  _c := public.begin_portal_change_fee(_req);
  _id := (_c->'charge'->>'id')::uuid;

  -- Not yet prepared: an event naming it is not matched, so it is retried.
  _out := public.record_portal_change_fee_event('evt_d6_early_0', 'payment_intent.succeeded', 'pi_test_early', 'acct_test_a', true, NULL, false, _id);
  IF _out <> 'unknown' THEN RAISE EXCEPTION 'PROOF FAILED [unprepared]: %', _out; END IF;

  PERFORM public.prepare_portal_change_fee(_id, 'acct_test_a');
  BEGIN
    PERFORM public.prepare_portal_change_fee(_id, 'acct_test_b');
    RAISE EXCEPTION 'PROOF FAILED [prepare]: a fee was prepared for a second account';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'This fee is not waiting to be charged on that account%' THEN RAISE; END IF;
  END;

  -- Another account naming this fee in its metadata finds nothing.
  _out := public.record_portal_change_fee_event('evt_d6_early_1', 'payment_intent.succeeded', 'pi_test_early', 'acct_test_b', true, NULL, false, _id);
  IF _out <> 'unknown' THEN RAISE EXCEPTION 'PROOF FAILED [early, other account]: %', _out; END IF;

  -- The real event, before the server stored the intent's id.
  _out := public.record_portal_change_fee_event('evt_d6_early_2', 'payment_intent.succeeded', 'pi_test_early', 'acct_test_a', true, NULL, false, _id);
  IF _out <> 'succeeded'
     OR (SELECT stripe_payment_intent_id FROM public.portal_change_fee_charges WHERE id = _id) <> 'pi_test_early' THEN
    RAISE EXCEPTION 'PROOF FAILED [early webhook]: an event before the server''s response did not settle the fee (%)', _out;
  END IF;

  -- The server's own response arrives afterwards and changes nothing.
  PERFORM public.note_portal_change_fee_attempt(_id, 'processing', 'pi_test_early', 'acct_test_a', NULL, false);
  IF (SELECT status FROM public.portal_change_fee_charges WHERE id = _id) <> 'succeeded' THEN
    RAISE EXCEPTION 'PROOF FAILED [late response]: the server''s response undid the webhook';
  END IF;
  RAISE NOTICE 'ok: a webhook before the server''s response settles the fee by fee id and account; another account cannot';
END $$;

-- ── 8. An approval about a visit the office has since moved (finding 3) ───
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073001');
SET LOCAL ROLE authenticated;
SELECT public.set_portal_change_settings('0a000000-0000-4000-8000-000000073000', 'approval', NULL, NULL);
RESET ROLE;

SELECT pg_temp.as_server();
DO $$
DECLARE _r jsonb;
BEGIN
  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073008', 'reschedule', current_date + 33, NULL, 1000, 'press-0008-a');
  INSERT INTO proof_req VALUES ('stale-resched', (_r->>'request_id')::uuid);
  _r := public.portal_request_visit_change('aaaaaaaa-0000-4000-8000-0000000730a1',
          '7a000000-0000-4000-8000-000000073009', 'cancel', NULL, NULL, 1500, 'press-0009-a');
  INSERT INTO proof_req VALUES ('stale-cancel', (_r->>'request_id')::uuid);
  -- The office moves both visits while the requests wait.
  UPDATE public.visits SET scheduled_on = scheduled_on + 40
   WHERE id IN ('7a000000-0000-4000-8000-000000073008', '7a000000-0000-4000-8000-000000073009');
END $$;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000073001');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _k text;
BEGIN
  FOREACH _k IN ARRAY ARRAY['stale-resched', 'stale-cancel'] LOOP
    BEGIN
      PERFORM public.decide_portal_change_request((SELECT id FROM proof_req WHERE k = _k), true, NULL);
      RAISE EXCEPTION 'PROOF FAILED [stale %]: an approval applied a request about a day the visit is no longer on', _k;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'STALE_REQUEST:%' THEN RAISE; END IF;
    END;
  END LOOP;
  -- Denying it is still possible, and is what the message says to do.
  PERFORM public.decide_portal_change_request((SELECT id FROM proof_req WHERE k = 'stale-cancel'), false, 'We moved this visit; please ask again.');
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT scheduled_on FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073008') <> current_date + 48
     OR (SELECT status FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000073009') <> 'scheduled'
     OR (SELECT status FROM public.portal_change_requests WHERE id = (SELECT id FROM proof_req WHERE k = 'stale-resched')) <> 'pending' THEN
    RAISE EXCEPTION 'PROOF FAILED [stale after]: a refused approval changed a visit or the request';
  END IF;
  RAISE NOTICE 'ok: an approval about a visit the office has since moved is refused, for a reschedule and a skip';
END $$;

-- ── 9. The client sees the answer (review finding 5) ──────────────────────
SELECT pg_temp.as_server();
DO $$
DECLARE _t record; _n int;
BEGIN
  SELECT * INTO _t FROM public.portal_visit_change_terms('aaaaaaaa-0000-4000-8000-0000000730a1')
   WHERE visit_id = '7a000000-0000-4000-8000-000000073009';
  IF _t.denied_kind IS DISTINCT FROM 'cancel' OR _t.denied_note IS DISTINCT FROM 'We moved this visit; please ask again.'
     OR _t.denied_at IS NULL OR _t.pending_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [denial on the visit]: the visit row does not carry the denial and its note (%)', _t;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.portal_list_change_requests('aaaaaaaa-0000-4000-8000-0000000730a1')
                  WHERE status = 'denied' AND decision_note = 'We moved this visit; please ask again.') THEN
    RAISE EXCEPTION 'PROOF FAILED [denial listed]: the client''s request list does not show the denial and note';
  END IF;
  SELECT count(*) INTO _n FROM public.portal_list_change_requests('bbbbbbbb-0000-4000-8000-0000000730b1');
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [denial cross-tenant]: business B''s client sees % of A''s requests', _n;
  END IF;
  RAISE NOTICE 'ok: a denial and the owner''s note stay visible to that client, on the visit and in their requests, and to nobody else';
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
              '7a000000-0000-4000-8000-000000073005', 'cancel', NULL, NULL, NULL, gen_random_uuid()::text);
    RAISE EXCEPTION 'PROOF FAILED [line cutoff]: a change past the line''s cutoff was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'This visit is past the change cutoff%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: a per-line cutoff is enforced on the server';
END $$;

ROLLBACK;
\echo ALL PORTAL-CHANGE-WAITS-FOR-THE-OWNER PROOFS PASSED
