-- Proof for 20260825070000 — a tech can complete a prepaid visit again, and
-- still cannot put money on a customer's account.
--
-- Four assertions. The last two are the ones that stop this being a hole:
-- the exemption must not let a tech CREDIT, and must not let them debit a
-- visit that is not theirs.

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON _ids TO authenticated;

DO $$
DECLARE
  _org uuid; _tech uuid; _other uuid; _staff uuid; _staff2 uuid;
  _cli uuid; _prop uuid; _sub uuid; _visit uuid; _visit2 uuid;
BEGIN
  PERFORM set_config('app.allow_protected_org_write', '1', true);

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'tech-a2@proof.invalid', '', now(), now(), now())
  RETURNING id INTO _tech;

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'other-a2@proof.invalid', '', now(), now(), now())
  RETURNING id INTO _other;

  INSERT INTO public.organizations (name) VALUES ('Prepaid Proof Co') RETURNING id INTO _org;
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_tech,  _org, 'tech');
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_other, _org, 'tech');

  INSERT INTO public.staff (organization_id, user_id, role, display_name)
  VALUES (_org, _tech, 'tech', 'Prepaid Tech') RETURNING id INTO _staff;
  INSERT INTO public.staff (organization_id, user_id, role, display_name)
  VALUES (_org, _other, 'tech', 'Other Tech') RETURNING id INTO _staff2;

  INSERT INTO public.clients (organization_id, account_type, display_name)
  VALUES (_org, 'residential', 'Prepaid Client') RETURNING id INTO _cli;
  INSERT INTO public.properties (client_id, organization_id, street, city, postal_code)
  VALUES (_cli, _org, '9 Prepaid Way', 'Detroit', '48203') RETURNING id INTO _prop;

  -- The shape that triggers the debit at all: prepaid, priced above zero.
  INSERT INTO public.subscriptions (organization_id, client_id, property_id, account_type,
                                    frequency, price_cents, dog_count, billing_cadence)
  VALUES (_org, _cli, _prop, 'residential', 'weekly', 6000, 1, 'prepaid')
  RETURNING id INTO _sub;

  INSERT INTO public.visits (organization_id, subscription_id, client_id, property_id,
                             assigned_staff_id, scheduled_on, status)
  VALUES (_org, _sub, _cli, _prop, _staff, CURRENT_DATE, 'scheduled') RETURNING id INTO _visit;

  -- A second visit, assigned to somebody else, for assertion 4.
  INSERT INTO public.visits (organization_id, subscription_id, client_id, property_id,
                             assigned_staff_id, scheduled_on, status)
  VALUES (_org, _sub, _cli, _prop, _staff2, CURRENT_DATE + 1, 'scheduled') RETURNING id INTO _visit2;

  INSERT INTO _ids VALUES ('org',_org),('tech',_tech),('cli',_cli),
                          ('visit',_visit),('visit2',_visit2);
  PERFORM set_config('app.allow_protected_org_write', '', true);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.be_tech() RETURNS void LANGUAGE plpgsql AS $$
DECLARE _u uuid;
BEGIN
  SELECT v INTO _u FROM _ids WHERE k = 'tech';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _u, 'role','authenticated')::text, true);
END $$;

-- ── 1. THE FIX: a tech completes a prepaid visit ─────────────────────────
DO $$
DECLARE _v uuid; _org uuid; _cli uuid; _n int;
BEGIN
  SELECT v INTO _v   FROM _ids WHERE k='visit';
  SELECT v INTO _org FROM _ids WHERE k='org';
  SELECT v INTO _cli FROM _ids WHERE k='cli';
  PERFORM pg_temp.be_tech();
  PERFORM public.finalize_visit_completion(_v);
  SELECT count(*) INTO _n FROM public.credit_ledger
   WHERE visit_id = _v AND kind = 'visit_debit' AND delta_cents = -6000;
  IF _n <> 1 THEN RAISE EXCEPTION '1 FAIL  expected one -6000 visit_debit, found %', _n; END IF;
  RAISE NOTICE '1 PASS  tech completed a prepaid visit and the debit posted (-6000)';
END $$;

-- ── 2. MUTATION: the old guard would have refused it ─────────────────────
-- Restore the pre-fix body, prove it fails, put the fix back. Without this the
-- test above cannot tell you the migration is what changed anything.
CREATE OR REPLACE FUNCTION pg_temp.old_guard() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE $f$
    CREATE OR REPLACE FUNCTION public.post_credit_entry(
      _org_id uuid, _client_id uuid, _delta integer, _kind text,
      _invoice_id uuid, _visit_id uuid, _note text)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp' AS $b$
    BEGIN
      IF auth.uid() IS NOT NULL THEN
        IF NOT public.has_permission(auth.uid(), _org_id, 'manage_client_billing') THEN
          RAISE EXCEPTION 'Not authorized for this organization.' USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;
      INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, invoice_id, visit_id, note)
      VALUES (_org_id, _client_id, _delta, _kind, _invoice_id, _visit_id, _note);
    END $b$;
  $f$;
END $$;

DO $$
DECLARE _v uuid; _ok boolean := false;
BEGIN
  SELECT v INTO _v FROM _ids WHERE k='visit2';
  PERFORM pg_temp.old_guard();
  PERFORM pg_temp.be_tech();
  BEGIN
    PERFORM public.finalize_visit_completion(_v);
  EXCEPTION WHEN insufficient_privilege THEN
    _ok := true;
    RAISE NOTICE '2 PASS  with the pre-fix body restored the tech WAS refused — the migration is what changed it';
  END;
  IF NOT _ok THEN
    RAISE EXCEPTION '2 INCONCLUSIVE  the old body did not refuse — this test proves nothing';
  END IF;
END $$;

ROLLBACK;

-- Everything above is rolled back, including the restored old body. Reconnect
-- state is untouched; the shipped function on this database is the migration's.
BEGIN;

CREATE TEMP TABLE _ids2 (k text PRIMARY KEY, v uuid);
GRANT SELECT ON _ids2 TO authenticated;

DO $$
DECLARE _org uuid; _tech uuid; _other uuid; _staff uuid; _staff2 uuid;
        _cli uuid; _prop uuid; _sub uuid; _visit uuid; _visit2 uuid;
BEGIN
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'tech-b@proof.invalid', '', now(), now(), now())
  RETURNING id INTO _tech;
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'other-b@proof.invalid', '', now(), now(), now())
  RETURNING id INTO _other;
  INSERT INTO public.organizations (name) VALUES ('Prepaid Proof Co 2') RETURNING id INTO _org;
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_tech,_org,'tech');
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_other,_org,'tech');
  INSERT INTO public.staff (organization_id,user_id,role,display_name)
  VALUES (_org,_tech,'tech','B Tech') RETURNING id INTO _staff;
  INSERT INTO public.staff (organization_id,user_id,role,display_name)
  VALUES (_org,_other,'tech','B Other') RETURNING id INTO _staff2;
  INSERT INTO public.clients (organization_id,account_type,display_name)
  VALUES (_org,'residential','B Client') RETURNING id INTO _cli;
  INSERT INTO public.properties (client_id,organization_id,street,city,postal_code)
  VALUES (_cli,_org,'1 B Way','Detroit','48204') RETURNING id INTO _prop;
  INSERT INTO public.subscriptions (organization_id,client_id,property_id,account_type,
                                    frequency,price_cents,dog_count,billing_cadence)
  VALUES (_org,_cli,_prop,'residential','weekly',6000,1,'prepaid') RETURNING id INTO _sub;
  INSERT INTO public.visits (organization_id,subscription_id,client_id,property_id,
                             assigned_staff_id,scheduled_on,status)
  VALUES (_org,_sub,_cli,_prop,_staff,CURRENT_DATE,'scheduled') RETURNING id INTO _visit;
  INSERT INTO public.visits (organization_id,subscription_id,client_id,property_id,
                             assigned_staff_id,scheduled_on,status)
  VALUES (_org,_sub,_cli,_prop,_staff2,CURRENT_DATE+1,'scheduled') RETURNING id INTO _visit2;
  INSERT INTO _ids2 VALUES ('org',_org),('tech',_tech),('cli',_cli),
                           ('visit',_visit),('visit2',_visit2);
  PERFORM set_config('app.allow_protected_org_write','',true);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.be_tech2() RETURNS void LANGUAGE plpgsql AS $$
DECLARE _u uuid;
BEGIN
  SELECT v INTO _u FROM _ids2 WHERE k='tech';
  PERFORM set_config('request.jwt.claims', json_build_object('sub',_u,'role','authenticated')::text, true);
END $$;

-- ── 3. THE EXEMPTION MUST NOT LET A TECH ADD CREDIT ──────────────────────
-- This is the hole 20260820140000 was written to close. If the new exemption
-- reopened it, the whole migration is a regression.
DO $$
DECLARE _org uuid; _cli uuid; _v uuid; _ok boolean := false;
BEGIN
  SELECT v INTO _org FROM _ids2 WHERE k='org';
  SELECT v INTO _cli FROM _ids2 WHERE k='cli';
  SELECT v INTO _v   FROM _ids2 WHERE k='visit';
  PERFORM pg_temp.be_tech2();
  BEGIN
    -- Positive delta, everything else identical to the permitted call.
    PERFORM public.post_credit_entry(_org, _cli, 50000, 'visit_debit', NULL, _v, 'free money');
  EXCEPTION WHEN insufficient_privilege THEN
    _ok := true;
    RAISE NOTICE '3 PASS  a tech still cannot CREDIT an account — the sign bound holds';
  END;
  IF NOT _ok THEN RAISE EXCEPTION '3 FAIL  the exemption let a tech add credit'; END IF;
END $$;

-- ── 4. NOR DEBIT SOMEBODY ELSE'S VISIT ───────────────────────────────────
DO $$
DECLARE _org uuid; _cli uuid; _v2 uuid; _ok boolean := false;
BEGIN
  SELECT v INTO _org FROM _ids2 WHERE k='org';
  SELECT v INTO _cli FROM _ids2 WHERE k='cli';
  SELECT v INTO _v2  FROM _ids2 WHERE k='visit2';
  PERFORM pg_temp.be_tech2();
  BEGIN
    PERFORM public.post_credit_entry(_org, _cli, -6000, 'visit_debit', NULL, _v2, 'not mine');
  EXCEPTION WHEN insufficient_privilege THEN
    _ok := true;
    RAISE NOTICE '4 PASS  a tech cannot debit a visit assigned to somebody else';
  END;
  IF NOT _ok THEN RAISE EXCEPTION '4 FAIL  the exemption reached another tech''s visit'; END IF;
END $$;

ROLLBACK;
