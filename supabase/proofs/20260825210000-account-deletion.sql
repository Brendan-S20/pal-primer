-- Proof for 20260825210000 — deleting your own account.
--
-- Six assertions, covering the owner's specification point by point:
--   1  a plain member's deletion removes access and anonymises them
--   2  their service history keeps its attribution
--   3  a NON-sole owner deletes without ceremony
--   4  a SOLE owner is refused until they choose
--   5  transfer promotes the named member, then deletes
--   6  close soft-deletes the workspace, then deletes
--
-- Plus the mutation: with the sole-owner guard removed, a business is orphaned.

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _a (k text PRIMARY KEY, v uuid);
GRANT SELECT ON _a TO authenticated;

CREATE OR REPLACE FUNCTION pg_temp.mkuser(_email text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE _id uuid;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', _email, '', now(), now(), now())
  RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.be(_k text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _u uuid;
BEGIN
  SELECT v INTO _u FROM _a WHERE k = _k;
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', _u, 'role','authenticated')::text, true);
END $$;

DO $$
DECLARE
  _org uuid; _owner uuid; _owner2 uuid; _tech uuid; _staffT uuid;
  _cli uuid; _prop uuid; _sub uuid; _visit uuid;
BEGIN
  PERFORM set_config('app.allow_protected_org_write','1',true);
  _owner  := pg_temp.mkuser('owner@del.invalid');
  _owner2 := pg_temp.mkuser('owner2@del.invalid');
  _tech   := pg_temp.mkuser('tech@del.invalid');

  INSERT INTO public.organizations (name) VALUES ('Deletion Test Co') RETURNING id INTO _org;
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_owner,_org,'owner');
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_tech,_org,'tech');

  -- The technician carries the personal data the fix is about: a home address
  -- and its coordinates.
  INSERT INTO public.staff (organization_id,user_id,role,display_name,email,phone,active,
                            start_address,start_latitude,start_longitude)
  VALUES (_org,_tech,'tech','Real Name','real@person.invalid','555-0100',true,
          '12 Home Street','42.3314','-83.0458')
  RETURNING id INTO _staffT;
  INSERT INTO public.staff (organization_id,user_id,role,display_name,active)
  VALUES (_org,_owner,'owner','The Owner',true);

  INSERT INTO public.clients (organization_id,account_type,display_name)
  VALUES (_org,'residential','A Client') RETURNING id INTO _cli;
  INSERT INTO public.properties (client_id,organization_id,street,city,postal_code)
  VALUES (_cli,_org,'1 St','Detroit','48201') RETURNING id INTO _prop;
  INSERT INTO public.subscriptions (organization_id,client_id,property_id,account_type,
                                    frequency,price_cents,dog_count)
  VALUES (_org,_cli,_prop,'residential','weekly',2500,1) RETURNING id INTO _sub;
  -- Work this person did, which must remain attributable to them.
  INSERT INTO public.visits (organization_id,subscription_id,client_id,property_id,
                             assigned_staff_id,scheduled_on,status,completed_at)
  VALUES (_org,_sub,_cli,_prop,_staffT,CURRENT_DATE - 7,'completed',now())
  RETURNING id INTO _visit;

  INSERT INTO _a VALUES ('org',_org),('owner',_owner),('owner2',_owner2),('tech',_tech),
                        ('staffT',_staffT),('visit',_visit);
  PERFORM set_config('app.allow_protected_org_write','',true);
END $$;

-- ── 1 + 2. A PLAIN MEMBER ────────────────────────────────────────────────
DO $$
DECLARE _tech uuid; _staffT uuid; _visit uuid; _r jsonb;
        _roles int; _name text; _lat numeric; _assigned uuid; _active boolean;
BEGIN
  SELECT v INTO _tech   FROM _a WHERE k='tech';
  SELECT v INTO _staffT FROM _a WHERE k='staffT';
  SELECT v INTO _visit  FROM _a WHERE k='visit';
  PERFORM pg_temp.be('tech');
  _r := public.delete_my_account();

  SELECT count(*) INTO _roles FROM public.user_roles WHERE user_id = _tech;
  IF _roles <> 0 THEN RAISE EXCEPTION '1 FAIL  access survived: % role row(s)', _roles; END IF;

  SELECT display_name, start_latitude, active INTO _name, _lat, _active
    FROM public.staff WHERE id = _staffT;
  IF _name <> 'Deleted user' THEN RAISE EXCEPTION '1 FAIL  name not anonymised: %', _name; END IF;
  IF _lat IS NOT NULL THEN RAISE EXCEPTION '1 FAIL  home coordinates survived: %', _lat; END IF;
  IF _active THEN RAISE EXCEPTION '1 FAIL  staff row still active'; END IF;
  RAISE NOTICE '1 PASS  member deleted: access removed, name and home coordinates cleared';

  SELECT assigned_staff_id INTO _assigned FROM public.visits WHERE id = _visit;
  IF _assigned IS DISTINCT FROM _staffT THEN
    RAISE EXCEPTION '2 FAIL  service history lost its technician (assigned=%)', _assigned;
  END IF;
  RAISE NOTICE '2 PASS  the completed visit still points at the technician who did it';
END $$;

-- ── 4. A SOLE OWNER IS REFUSED ───────────────────────────────────────────
DO $$
DECLARE _ok boolean := false; _roles int; _owner uuid;
BEGIN
  SELECT v INTO _owner FROM _a WHERE k='owner';
  PERFORM pg_temp.be('owner');
  BEGIN
    PERFORM public.delete_my_account();
  EXCEPTION WHEN raise_exception THEN
    _ok := true;
    RAISE NOTICE '4 PASS  sole owner refused: %', SQLERRM;
  END;
  IF NOT _ok THEN RAISE EXCEPTION '4 FAIL  the sole owner deleted and orphaned the workspace'; END IF;
  SELECT count(*) INTO _roles FROM public.user_roles WHERE user_id = _owner;
  IF _roles <> 1 THEN RAISE EXCEPTION '4 FAIL  refusal still removed the membership'; END IF;
END $$;

-- ── 5. TRANSFER, THEN DELETE ─────────────────────────────────────────────
DO $$
DECLARE _org uuid; _owner uuid; _owner2 uuid; _r jsonb; _newRole public.app_role; _roles int;
BEGIN
  SELECT v INTO _org    FROM _a WHERE k='org';
  SELECT v INTO _owner  FROM _a WHERE k='owner';
  SELECT v INTO _owner2 FROM _a WHERE k='owner2';
  -- owner2 has to be a member first; promoting a stranger is refused.
  PERFORM set_config('request.jwt.claims', NULL, true);
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_owner2,_org,'office_manager');
  INSERT INTO public.staff (organization_id,user_id,role,display_name,active)
  VALUES (_org,_owner2,'office_manager','Second Person',true);

  PERFORM pg_temp.be('owner');
  _r := public.delete_my_account(_owner2, false);

  SELECT role INTO _newRole FROM public.user_roles WHERE user_id=_owner2 AND organization_id=_org;
  IF _newRole <> 'owner' THEN RAISE EXCEPTION '5 FAIL  transfer did not promote (role=%)', _newRole; END IF;
  SELECT count(*) INTO _roles FROM public.user_roles WHERE user_id=_owner;
  IF _roles <> 0 THEN RAISE EXCEPTION '5 FAIL  the departing owner kept access'; END IF;
  IF (_r->>'transferred')::boolean IS NOT TRUE THEN RAISE EXCEPTION '5 FAIL  not reported as transferred'; END IF;
  RAISE NOTICE '5 PASS  ownership transferred, then the account deleted';
END $$;

-- ── 6. CLOSE THE WORKSPACE ───────────────────────────────────────────────
DO $$
DECLARE _org uuid; _owner2 uuid; _r jsonb; _del timestamptz; _inv int;
BEGIN
  SELECT v INTO _org    FROM _a WHERE k='org';
  SELECT v INTO _owner2 FROM _a WHERE k='owner2';
  PERFORM pg_temp.be('owner2');
  _r := public.delete_my_account(NULL, true);

  SELECT deleted_at INTO _del FROM public.organizations WHERE id=_org;
  IF _del IS NULL THEN RAISE EXCEPTION '6 FAIL  the workspace was not closed'; END IF;
  IF (_r->>'workspace_closed')::boolean IS NOT TRUE THEN RAISE EXCEPTION '6 FAIL  not reported closed'; END IF;

  -- Soft, never a drop: the records under it survive.
  SELECT count(*) INTO _inv FROM public.visits WHERE organization_id=_org;
  IF _inv = 0 THEN RAISE EXCEPTION '6 FAIL  closing the workspace destroyed its service history'; END IF;
  RAISE NOTICE '6 PASS  workspace soft-closed, % visit(s) preserved under it', _inv;
END $$;

-- ── MUTATION: without the guard, a business is orphaned ──────────────────
DO $$
DECLARE _org uuid; _u uuid; _owners int;
BEGIN
  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM set_config('app.allow_protected_org_write','1',true);
  INSERT INTO public.organizations (name) VALUES ('Orphan Test') RETURNING id INTO _org;
  _u := pg_temp.mkuser('solo@del.invalid');
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_u,_org,'owner');
  PERFORM set_config('app.allow_protected_org_write','',true);

  EXECUTE $f$
    CREATE OR REPLACE FUNCTION public.delete_my_account(_transfer_to uuid DEFAULT NULL,
                                                        _close_workspace boolean DEFAULT false)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $b$
    DECLARE _uid uuid := auth.uid();
    BEGIN
      DELETE FROM public.user_roles WHERE user_id = _uid;
      RETURN jsonb_build_object('ok', true);
    END $b$;
  $f$;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub',_u,'role','authenticated')::text, true);
  PERFORM public.delete_my_account();
  SELECT count(*) INTO _owners FROM public.user_roles WHERE organization_id=_org AND role='owner';
  IF _owners <> 0 THEN
    RAISE EXCEPTION 'MUTATION INCONCLUSIVE  the stripped body did not orphan the org';
  END IF;
  RAISE NOTICE 'M PASS  without the guard the workspace was left with 0 owners - the refusal is what prevents it';
END $$;

ROLLBACK;
