-- An owner sets each role's permissions; today's rules are the defaults
-- (#863, umbrella #460). Brendan, 2026-11-10: "Let managers too, but really
-- these roles should have a set of permissions to let the owner to run
-- through and set."
--
-- WHAT THIS FILE ESTABLISHES
--
--   1. public.permission_default(role, permission): the matrix as main
--      shipped it on 2026-11-11, verbatim from has_permission
--      (20261108152800). It is what a business runs on until its owner
--      changes something. tests/permission-parity.test.ts holds it to
--      ROLE_PERMISSIONS in src/lib/permissions.ts.
--
--   2. public.role_permission_overrides: one row per (business, role,
--      permission) the owner changed, allowed true or false. No row means
--      the default. Members of the business read their own rows (the app
--      reads them for the signed-in person); only the owner writes. A CHECK
--      keeps the floor: no row may hand manage_org_billing or
--      manage_franchise to anyone, and no row is ever about the owner, who
--      holds everything.
--
--   3. public.has_permission reads the overrides. The caller guard, the
--      second-step guard and the turned-off guard are kept word for word;
--      the role clauses become: an owner, or (not an owner-only permission,
--      and the stored answer, else the default). RLS, every RPC and every
--      server function that asks has_permission or requirePermission now
--      read the same stored set.
--
--   4. Every change is logged to activity_log (role_permissions.changed,
--      with who, which role, which permission, on or off or back to the
--      default) by a trigger, with the actor's name.
--
--   5. The floors no toggle can lift:
--        * nobody but an owner changes or turns off an owner, or gives a
--          role above their own: set_staff_active, change_user_role and the
--          restrictive UPDATE policy on staff keep those rules (20261111120000)
--          and now ask has_permission(manage_users) for the non-owner path,
--          so the owner can hand "manage the team" to a dispatcher, or take
--          it from an office manager, and the limits still hold;
--        * a technician reads a home's gate code on their assigned visit day
--          only, even with view_client_directory turned on for technicians:
--          property_access_codes and stay_access_codes exclude the tech role
--          from their office branch. Names and addresses may be opened to a
--          technician; the code to the door is not.
--
--   6. Brendan's dispatcher defaults (2026-11-12, 11:45 AM ET): a dispatcher
--      CAN cancel a visit and CAN complete one for a technician, and CANNOT
--      choose prepaid billing. Completing and canceling from the office were
--      manage_client_billing, which would also hand a dispatcher invoices,
--      refunds, prepaid and credit; they are their own permission now,
--      close_visits, on by default for owner, office manager and dispatcher.
--      office_complete_visit and office_skip_visit ask has_permission for it
--      (they asked can_write_org, which any dispatcher passed, so turning it
--      off would not have reached a direct RPC). Prepaid stays
--      manage_client_billing: the subscriptions write policies
--      (manage_pricing), generate_prepaid_invoice (manage_client_billing) and
--      onboardClient's PLAN_CADENCE_IS_BILLING refusal are untouched.
--
-- NOTHING CHANGES FOR AN EXISTING BUSINESS. The table starts empty, and an
-- empty table is the matrix every business already runs on. Replays into an
-- empty database: definitions, and assertions about what this file creates.
-- Runs twice without change (IF NOT EXISTS, OR REPLACE, DROP IF EXISTS).

-- ── 1. The defaults, as a function ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.permission_default(_role public.app_role, _permission text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 PARALLEL SAFE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN _role = 'owner' THEN true
    WHEN _role = 'office_manager' THEN _permission NOT IN ('manage_org_billing', 'manage_franchise')
    WHEN _role = 'dispatcher' THEN _permission IN ('view_client_directory', 'record_field_addons', 'booking', 'manage_schedule', 'close_visits', 'message_clients')
    WHEN _role = 'tech' THEN _permission = 'record_field_addons'
    ELSE false
  END;
$function$;

REVOKE ALL ON FUNCTION public.permission_default(public.app_role, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.permission_default(public.app_role, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.permission_default(public.app_role, text) IS
  'What a role holds when its business''s owner has changed nothing (#863): the matrix has_permission carried until 20261112010000, plus close_visits for the dispatcher (Brendan, 2026-11-12), mirrored by ROLE_PERMISSIONS in src/lib/permissions.ts (tests/permission-parity.test.ts).';

-- ── 2. What the owner changed ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.role_permission_overrides (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  permission text NOT NULL,
  allowed boolean NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, role, permission),
  -- The owner is not configurable: an owner holds everything.
  CONSTRAINT role_permission_overrides_role_is_configurable
    CHECK (role IN ('office_manager'::public.app_role, 'dispatcher'::public.app_role, 'tech'::public.app_role)),
  CONSTRAINT role_permission_overrides_permission_is_a_name
    CHECK (permission ~ '^[a-z_]{3,60}$'),
  -- The floor: the business's own plan and payouts, and the franchise, are
  -- the owner's whatever is stored. A row turning them OFF is allowed and
  -- changes nothing; a row turning them ON is refused.
  CONSTRAINT role_permission_overrides_owner_only_floor
    CHECK (NOT (allowed AND permission IN ('manage_org_billing', 'manage_franchise')))
);

COMMENT ON TABLE public.role_permission_overrides IS
  'Per business, per role: the permissions the owner turned on or off (#863). No row means the default (permission_default). Read by has_permission, requirePermission and the shell; written by the owner alone from Settings -> Roles & permissions; every change logged to activity_log.';

CREATE INDEX IF NOT EXISTS role_permission_overrides_org_role_idx
  ON public.role_permission_overrides (organization_id, role);

ALTER TABLE public.role_permission_overrides ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.role_permission_overrides');

-- Supabase's default privileges hand anon and authenticated everything;
-- what is kept is what the policies below scope (#842 for the other three).
REVOKE ALL ON public.role_permission_overrides FROM PUBLIC, anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.role_permission_overrides FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permission_overrides TO authenticated;
GRANT ALL ON public.role_permission_overrides TO service_role;

-- Everyone on the team reads their business's rows: the app reads the
-- signed-in person's own role's rows to draw the right controls. Another
-- business's rows are never visible.
DROP POLICY IF EXISTS "Members read their business's role permissions" ON public.role_permission_overrides;
CREATE POLICY "Members read their business's role permissions" ON public.role_permission_overrides
  FOR SELECT TO authenticated
  USING (public.is_org_member((SELECT auth.uid()), organization_id));

-- Only the owner writes. has_role, not has_permission: a business must not
-- be able to hand out the key to this table through this table.
DROP POLICY IF EXISTS "Only the owner adds a role permission" ON public.role_permission_overrides;
CREATE POLICY "Only the owner adds a role permission" ON public.role_permission_overrides
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));

DROP POLICY IF EXISTS "Only the owner changes a role permission" ON public.role_permission_overrides;
CREATE POLICY "Only the owner changes a role permission" ON public.role_permission_overrides
  FOR UPDATE TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role))
  WITH CHECK (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));

DROP POLICY IF EXISTS "Only the owner removes a role permission" ON public.role_permission_overrides;
CREATE POLICY "Only the owner removes a role permission" ON public.role_permission_overrides
  FOR DELETE TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));

-- ── 3. has_permission reads the stored set ──────────────────────────────────
-- The three guards are the ones 20261009180000 and 20261002010000 put here,
-- unchanged. Only the role clauses move: into permission_default, behind
-- the stored answer.
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _org_id uuid, _permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ((SELECT auth.uid()) IS NULL OR _user_id IS NOT DISTINCT FROM (SELECT auth.uid()))
     AND public.mfa_satisfied()
     AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.organization_id = _org_id
      AND (
        ur.role = 'owner'
        OR (
          -- The floor: these are the owner's whatever the business stored.
          _permission NOT IN ('manage_org_billing', 'manage_franchise')
          AND COALESCE(
            (SELECT o.allowed
               FROM public.role_permission_overrides o
              WHERE o.organization_id = _org_id
                AND o.role = ur.role
                AND o.permission = _permission),
            public.permission_default(ur.role, _permission))
        )
      )
  )
     AND NOT EXISTS (
    SELECT 1 FROM public.staff s
    WHERE s.organization_id = _org_id AND s.user_id = _user_id AND NOT s.active
  );
$function$;

REVOKE ALL ON FUNCTION public.has_permission(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.has_permission(uuid, uuid, text) IS
  'The stored answer for the caller''s business and role (role_permission_overrides, #863), else permission_default, which mirrors ROLE_PERMISSIONS in src/lib/permissions.ts. An owner holds everything; manage_org_billing and manage_franchise are the owner''s whatever is stored. Answers only about the CALLER, only after the second step when they have one, and never for a person whose staff row in that organization is turned off (20261009180000).';

-- ── 4. Who changed what ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_log_role_permission_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _actor uuid := auth.uid();
  _label text;
  _org uuid := COALESCE(NEW.organization_id, OLD.organization_id);
  _role text := COALESCE(NEW.role, OLD.role)::text;
  _permission text := COALESCE(NEW.permission, OLD.permission);
  _to text;
BEGIN
  IF _actor IS NULL THEN
    _label := 'system';
  ELSE
    SELECT s.display_name INTO _label
      FROM public.staff s
     WHERE s.user_id = _actor AND s.organization_id = _org
     LIMIT 1;
    _label := COALESCE(_label, 'Someone outside the team');
  END IF;
  _to := CASE WHEN TG_OP = 'DELETE' THEN 'the default'
              WHEN NEW.allowed THEN 'on' ELSE 'off' END;
  INSERT INTO public.activity_log (organization_id, actor_user_id, actor_label, kind, summary, meta)
  VALUES (
    _org, _actor, left(_label, 200), 'role_permissions.changed',
    left(format('%s set %s for %s to %s', _label, _permission, _role, _to), 500),
    jsonb_build_object(
      'role', _role, 'permission', _permission,
      'from', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD.allowed) END,
      'to', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW.allowed) END)
  );
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_log_role_permission_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS role_permission_overrides_log_change ON public.role_permission_overrides;
CREATE TRIGGER role_permission_overrides_log_change
  AFTER INSERT OR UPDATE OR DELETE ON public.role_permission_overrides
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_log_role_permission_change();

-- ── 5a. Staff authority asks the stored set, within the floors ──────────────
-- owner 3, office_manager 2, dispatcher 1, tech 0. platform_admin is not a
-- rank anybody but an owner can reach, so it has none.
CREATE OR REPLACE FUNCTION public.role_rank(_role text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 PARALLEL SAFE
 SET search_path TO ''
AS $function$
  SELECT CASE _role
    WHEN 'owner' THEN 3
    WHEN 'office_manager' THEN 2
    WHEN 'dispatcher' THEN 1
    WHEN 'tech' THEN 0
    ELSE NULL
  END;
$function$;

-- Called only inside caller_may_grant_role, which runs as its owner: not the
-- app's to call, so no grant at all.
REVOKE ALL ON FUNCTION public.role_rank(text) FROM PUBLIC, anon, authenticated, service_role;

-- May the caller hand out this role in this business? An owner, any. Anyone
-- else: only with manage_users as the owner configured it, and only a role
-- at or below their own, which is never owner and never platform_admin.
CREATE OR REPLACE FUNCTION public.caller_may_grant_role(_org_id uuid, _role text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT public.has_role((SELECT auth.uid()), _org_id, 'owner'::public.app_role)
      OR (
        public.has_permission((SELECT auth.uid()), _org_id, 'manage_users')
        AND _role NOT IN ('owner', 'platform_admin')
        AND public.role_rank(_role) <= (
          SELECT public.role_rank(ur.role::text)
            FROM public.user_roles ur
           WHERE ur.user_id = (SELECT auth.uid()) AND ur.organization_id = _org_id
           LIMIT 1)
      );
$function$;

REVOKE ALL ON FUNCTION public.caller_may_grant_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_may_grant_role(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.caller_may_grant_role(uuid, text) IS
  'An owner may grant any role. Anyone else may grant a role at or below their own, and only while their role holds manage_users as the owner configured it (#863, #659).';

CREATE OR REPLACE FUNCTION public.set_staff_active(_staff_id uuid, _active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.staff WHERE id = _staff_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'staff not found'; END IF;
  IF public.has_role(auth.uid(), _org, 'owner'::app_role) THEN
    NULL;
  ELSIF public.has_permission(auth.uid(), _org, 'manage_users') THEN
    -- D7 as changed 2026-11-10 (#659), as the owner configured it (#863):
    -- someone allowed to manage the team, but never on an owner.
    IF public.staff_row_is_an_owner(_staff_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'Only an owner can turn the owner on or off.';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only someone allowed to manage the team can turn people on or off.';
  END IF;
  -- The last owner who is on cannot be turned off: tg_keep_an_active_owner.
  UPDATE public.staff SET active = _active WHERE id = _staff_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_staff_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_staff_active(uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.change_user_role(_org_id uuid, _user_id uuid, _new_role app_role)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.has_role(auth.uid(), _org_id, 'owner'::app_role) THEN
    NULL;
  ELSIF public.has_permission(auth.uid(), _org_id, 'manage_users') THEN
    -- D7 as changed 2026-11-10 (#659), as the owner configured it (#863).
    -- Never a role above their own.
    IF NOT public.caller_may_grant_role(_org_id, _new_role::text) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'Nobody but an owner can give anyone a role above their own.';
    END IF;
    -- Never the owner.
    IF EXISTS (SELECT 1 FROM public.user_roles
                WHERE user_id = _user_id AND organization_id = _org_id AND role = 'owner'::app_role)
       OR EXISTS (SELECT 1 FROM public.staff
                   WHERE user_id = _user_id AND organization_id = _org_id AND role = 'owner'::staff_role) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'Only an owner can change the owner''s role.';
    END IF;
    -- Only somebody already on this team. The owner's path below inserts a
    -- role row when there is none; everyone else adds people by invite.
    IF NOT EXISTS (SELECT 1 FROM public.user_roles
                    WHERE user_id = _user_id AND organization_id = _org_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'That person is not on your team.';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only someone allowed to manage the team can change roles.';
  END IF;
  -- Prevent removing the last owner
  IF _new_role <> 'owner'::app_role AND EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND organization_id = _org_id AND role = 'owner'::app_role
  ) THEN
    IF (SELECT COUNT(*) FROM public.user_roles WHERE organization_id = _org_id AND role = 'owner'::app_role) <= 1 THEN
      RAISE EXCEPTION 'Cannot demote the last owner';
    END IF;
  END IF;
  UPDATE public.user_roles SET role = _new_role WHERE user_id = _user_id AND organization_id = _org_id;
  IF NOT FOUND THEN
    INSERT INTO public.user_roles(user_id, organization_id, role) VALUES (_user_id, _org_id, _new_role);
  END IF;
  -- Keep the staff row's role and field-worker flag in step with the new role
  -- (C3): a manual override on is_field_tech is preserved.
  UPDATE public.staff
     SET role = _new_role::text::public.staff_role,
         is_field_tech = CASE WHEN is_field_tech_overridden THEN is_field_tech
                              ELSE (_new_role = 'tech') END
   WHERE user_id = _user_id AND organization_id = _org_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.change_user_role(uuid, uuid, app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_user_role(uuid, uuid, app_role) TO authenticated, service_role;

-- PATCH /rest/v1/staff: the same rule. An owner anything; anyone else only
-- with manage_users, only a role at or below their own, never on an owner's
-- row. Address, routing and skill edits change neither and pass as before.
DROP POLICY IF EXISTS "Only an owner changes who is on or their role" ON public.staff;
DROP POLICY IF EXISTS "Owner or office manager sets who is on; never the owner" ON public.staff;
DROP POLICY IF EXISTS "Whoever manages the team sets who is on; never the owner" ON public.staff;
CREATE POLICY "Whoever manages the team sets who is on; never the owner" ON public.staff
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (
    public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role)
    OR public.staff_authority_unchanged(id, active, role)
    OR (
      public.caller_may_grant_role(organization_id, role::text)
      AND NOT public.staff_row_is_an_owner(id)
    )
  );

-- ── 5b. A technician's gate code is for the assigned day ────────────────────
-- Verbatim 20261024080500 / 20261024081000, with one clause each: the office
-- branch (view_client_directory) is not open to the tech role, so turning
-- "See every client" on for technicians opens names and addresses, not the
-- code to the door.
CREATE OR REPLACE FUNCTION public.property_access_codes(_property_ids uuid[])
RETURNS TABLE (property_id uuid, gate_code text, lock_box_code text, key_location text, key_tag text, alarm_notes text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.id, p.gate_code, p.lock_box_code, p.key_location, p.key_tag, p.alarm_notes
    FROM public.properties p
    JOIN public.organizations o ON o.id = p.organization_id
   WHERE p.id = ANY (COALESCE(_property_ids, '{}'::uuid[]))
     AND (
       (
         public.has_permission((SELECT auth.uid()), p.organization_id, 'view_client_directory')
         -- The floor (#863): a technician reads a code on their day only.
         AND NOT public.has_role((SELECT auth.uid()), p.organization_id, 'tech'::public.app_role)
       )
       OR EXISTS (
         SELECT 1
           FROM public.visits v
           JOIN public.staff s ON s.id = v.assigned_staff_id
          WHERE v.property_id = p.id
            AND v.organization_id = p.organization_id
            AND s.user_id = (SELECT auth.uid())
            AND s.organization_id = p.organization_id
            AND s.active
            AND v.status IN ('scheduled', 'in_progress')
            AND v.scheduled_on = (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date
            -- A stay visit opens the codes only through stay_access_codes.
            AND NOT EXISTS (SELECT 1 FROM public.subscriptions sub
                             WHERE sub.id = v.subscription_id AND sub.stay_id IS NOT NULL)
       )
     );
$function$;
REVOKE ALL ON FUNCTION public.property_access_codes(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.property_access_codes(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.property_access_codes(uuid[]) IS
  'Gate code, lock box code, key location, key tag and alarm details. Office (view_client_directory, never the tech role), or an active tech assigned to a scheduled or in-progress visit at the property today that is not a stay visit. Plain SELECT of these columns is revoked from authenticated. Migrations 20261015215000, 20261024080500, 20261112010000.';

CREATE OR REPLACE FUNCTION public.stay_access_codes(_stay_ids uuid[])
RETURNS TABLE (
  stay_id uuid,
  property_id uuid,
  gate_code text,
  lock_box_code text,
  key_location text,
  key_tag text,
  alarm_notes text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  _uid uuid := auth.uid();
  _row record;
  _staff_name text;
BEGIN
  IF _uid IS NULL THEN RETURN; END IF;
  FOR _row IN
    SELECT st.id AS stay_id, st.organization_id, st.client_id, p.id AS property_id,
           p.gate_code, p.lock_box_code, p.key_location, p.key_tag, p.alarm_notes,
           (public.has_permission(_uid, st.organization_id, 'view_client_directory')
            AND NOT public.has_role(_uid, st.organization_id, 'tech'::public.app_role)) AS office
      FROM (SELECT DISTINCT a.id FROM unnest(COALESCE(_stay_ids, '{}'::uuid[])) AS a(id)) asked
      JOIN public.stays st ON st.id = asked.id
      JOIN public.properties p ON p.id = st.property_id
      JOIN public.organizations o ON o.id = st.organization_id
      CROSS JOIN LATERAL (
        SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date AS today
      ) t
      CROSS JOIN LATERAL (
        SELECT min(v.scheduled_on) AS first_day, max(v.scheduled_on) AS last_day
          FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
         WHERE s.stay_id = st.id AND v.status <> 'canceled'
      ) w
     WHERE st.status <> 'canceled'
       AND (
         (
           public.has_permission(_uid, st.organization_id, 'view_client_directory')
           -- The floor (#863): a technician reads a code on their days only.
           AND NOT public.has_role(_uid, st.organization_id, 'tech'::public.app_role)
         )
         -- The stay's sitter: the whole window.
         OR EXISTS (
           SELECT 1
             FROM public.staff sf
             JOIN public.visits v ON v.assigned_staff_id = sf.id
             JOIN public.subscriptions s ON s.id = v.subscription_id
            WHERE sf.id = st.assigned_staff_id
              AND sf.user_id = _uid
              AND sf.organization_id = st.organization_id
              AND sf.active
              AND s.stay_id = st.id
              AND v.status <> 'canceled'
              AND t.today BETWEEN w.first_day - 1 AND w.last_day
         )
         -- Anyone covering a visit: that visit's day.
         OR EXISTS (
           SELECT 1
             FROM public.staff sf
             JOIN public.visits v ON v.assigned_staff_id = sf.id
             JOIN public.subscriptions s ON s.id = v.subscription_id
            WHERE sf.user_id = _uid
              AND sf.organization_id = st.organization_id
              AND sf.active
              AND s.stay_id = st.id
              AND v.status IN ('scheduled', 'in_progress')
              AND v.scheduled_on = t.today
         )
       )
     LIMIT 200
  LOOP
    SELECT display_name INTO _staff_name FROM public.staff
     WHERE user_id = _uid AND organization_id = _row.organization_id LIMIT 1;
    INSERT INTO public.activity_log (organization_id, client_id, property_id, actor_user_id, actor_label, kind, summary, meta)
    VALUES (_row.organization_id, _row.client_id, _row.property_id, _uid, _staff_name, 'stay.access_viewed',
            'Viewed the access codes for a stay',
            jsonb_build_object('stay_id', _row.stay_id, 'as', CASE WHEN _row.office THEN 'office' ELSE 'sitter' END));
    stay_id := _row.stay_id;
    property_id := _row.property_id;
    gate_code := _row.gate_code;
    lock_box_code := _row.lock_box_code;
    key_location := _row.key_location;
    key_tag := _row.key_tag;
    alarm_notes := _row.alarm_notes;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.stay_access_codes(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stay_access_codes(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.stay_access_codes(uuid[]) IS
  'Gate code, lock box code, key location, key tag and alarm details for each stay''s home. The office (view_client_directory, never the tech role); the stay''s sitter (stays.assigned_staff_id) from the day before its first visit to its last visit day; anyone else assigned to a scheduled or in-progress visit of the stay on that visit''s day only. Every row returned is logged to activity_log as stay.access_viewed. Migrations 20261024080500, 20261024081000, 20261112010000.';

-- ── 5c. Completing and canceling from the office ask close_visits ───────────
-- Verbatim 20261102120000 (office_complete_visit) and 20261023130000
-- (office_skip_visit), with one clause each: can_write_org, which every
-- dispatcher passes, becomes has_permission(close_visits), which the owner
-- can take from a role. The server functions ask the same
-- (visits.functions.ts, loadVisitForOfficeAction).
CREATE OR REPLACE FUNCTION public.office_complete_visit(
  _visit_id uuid,
  -- Why the office is completing a visit with no completion photo, or with
  -- required checklist items nobody checked. Required exactly when one of
  -- those is missing.
  _override_reason text DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid;
  _status public.visit_status;
  _required boolean;
  _checklist jsonb;
  _line text;
  _has_photo boolean;
  _photo_missing boolean;
  _missing text;
  _why text := left(NULLIF(btrim(COALESCE(_override_reason, '')), ''), 250);
  _answers jsonb;
BEGIN
  SELECT organization_id, status INTO _org, _status
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  -- close_visits as the owner configured it (#863): a dispatcher by default.
  IF NOT public.has_permission(auth.uid(), _org, 'close_visits') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status NOT IN ('scheduled','in_progress','missed') THEN
    RAISE EXCEPTION 'Only scheduled, in-progress, or missed visits can be completed';
  END IF;

  -- The same two questions complete_visit asks, decided the same way: the
  -- visit's line is its service's; with no service, the business's only line
  -- when it runs exactly one, else pet waste.
  SELECT COALESCE(o.require_completion_photo, true), COALESCE(o.visit_checklist, '[]'::jsonb),
         COALESCE(s.service_line,
                  CASE WHEN cardinality(o.service_lines) = 1 THEN o.service_lines[1] END,
                  'pet_waste')
    INTO _required, _checklist, _line
    FROM public.visits v
    JOIN public.organizations o ON o.id = v.organization_id
    LEFT JOIN public.services s ON s.id = v.service_id
   WHERE v.id = _visit_id;

  IF jsonb_typeof(_checklist) = 'array' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb)
      INTO _checklist
      FROM jsonb_array_elements(_checklist) WITH ORDINALITY AS c(item, ord)
     WHERE NOT (item ? 'line') OR item ->> 'line' = _line;
  ELSE
    _checklist := '[]'::jsonb;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion')
    INTO _has_photo;
  _photo_missing := _required AND NOT _has_photo;

  -- Nobody in the office checked an item, so every required one is missing.
  SELECT string_agg(item ->> 'label', ', ' ORDER BY ord)
    INTO _missing
    FROM jsonb_array_elements(_checklist) WITH ORDINALITY AS c(item, ord)
   WHERE COALESCE((item ->> 'required')::boolean, false);

  IF (_photo_missing OR _missing IS NOT NULL) AND _why IS NULL THEN
    RAISE EXCEPTION 'This visit has %. Say why you are completing it from the office.',
      concat_ws(' and ',
        CASE WHEN _photo_missing THEN 'no completion photo' END,
        CASE WHEN _missing IS NOT NULL THEN 'required checklist items nobody checked (' || _missing || ')' END);
  END IF;

  IF jsonb_array_length(_checklist) > 0 THEN
    SELECT jsonb_agg(
             jsonb_build_object(
               'id', item ->> 'id',
               'label', item ->> 'label',
               'required', COALESCE((item ->> 'required')::boolean, false),
               'checked', false
             ) ORDER BY ord)
      INTO _answers
      FROM jsonb_array_elements(_checklist) WITH ORDINALITY AS c(item, ord);
  END IF;

  -- Note it still does NOT touch started_at (BUG-9).
  UPDATE public.visits
     SET status = 'completed', completed_at = now(), updated_at = now(),
         completion_source = 'office',
         completion_photo_waived_reason = CASE
           WHEN _photo_missing THEN 'Completed from the office: ' || _why
           ELSE completion_photo_waived_reason END,
         -- Answers already on the visit are kept: only complete_visit writes
         -- them, and only on completion, so today there are none here; if
         -- that changes, the tech's answers outrank the office's "unchecked".
         visit_checklist = COALESCE(visit_checklist, _answers)
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM public.finalize_visit_completion(_visit_id);
END;
$function$;


REVOKE ALL ON FUNCTION public.office_complete_visit(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_complete_visit(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.office_skip_visit(
  _visit_id uuid, _reason text, _code public.skip_reason_code DEFAULT 'other'::public.skip_reason_code,
  _client_cancelled_at timestamptz DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _price integer; _pct integer; _charge integer;
BEGIN
  SELECT v.organization_id, s.price_cents
    INTO _org, _price
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  -- close_visits as the owner configured it (#863): a dispatcher by default.
  IF NOT public.has_permission(auth.uid(), _org, 'close_visits') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to cancel a visit';
  END IF;
  IF _client_cancelled_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'The time the client canceled cannot be in the future';
  END IF;

  SELECT billable_pct INTO _pct
    FROM public.skip_billing_rules
   WHERE organization_id = _org AND reason_code = _code;
  IF _pct IS NULL THEN
    _pct := public.default_skip_billable_pct(_code);
  END IF;

  _charge := ROUND(COALESCE(_price, 0) * _pct / 100.0)::int;

  UPDATE public.visits
     SET status = 'skipped',
         skip_reason = _reason,
         skip_reason_code = _code,
         skip_billable = (_charge > 0),
         skip_charge_cents = _charge,
         client_cancelled_at = _client_cancelled_at,
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
END; $function$;

REVOKE ALL ON FUNCTION public.office_skip_visit(uuid, text, public.skip_reason_code, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_skip_visit(uuid, text, public.skip_reason_code, timestamptz) TO authenticated;

-- ── 6. What this file establishes, checked from any starting state ─────────
DO $post$
DECLARE
  _fn constant regprocedure := 'public.has_permission(uuid, uuid, text)'::regprocedure;
  _src text;
  _n bigint;
BEGIN
  -- The defaults are the matrix main shipped.
  IF NOT public.permission_default('owner', 'manage_org_billing')
     OR public.permission_default('office_manager', 'manage_org_billing')
     OR public.permission_default('office_manager', 'manage_franchise')
     OR NOT public.permission_default('office_manager', 'manage_users')
     OR NOT public.permission_default('dispatcher', 'booking')
     OR NOT public.permission_default('dispatcher', 'close_visits')
     OR public.permission_default('dispatcher', 'manage_client_billing')
     OR public.permission_default('tech', 'close_visits')
     OR public.permission_default('dispatcher', 'manage_pricing')
     OR NOT public.permission_default('tech', 'record_field_addons')
     OR public.permission_default('tech', 'view_client_directory') THEN
    RAISE EXCEPTION 'permission_default is not the matrix main shipped on 2026-11-11';
  END IF;

  -- The table, with its floor and its owner-only writes.
  IF to_regclass('public.role_permission_overrides') IS NULL THEN
    RAISE EXCEPTION 'role_permission_overrides was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.role_permission_overrides'::regclass
                    AND conname = 'role_permission_overrides_owner_only_floor') THEN
    RAISE EXCEPTION 'the owner-only floor is not a constraint on role_permission_overrides';
  END IF;
  SELECT count(*) INTO _n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'role_permission_overrides' AND permissive = 'PERMISSIVE';
  IF _n <> 4 THEN
    RAISE EXCEPTION 'role_permission_overrides has % permissive policies, expected 4', _n;
  END IF;
  SELECT count(*) INTO _n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'role_permission_overrides' AND permissive = 'PERMISSIVE'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
     AND strpos(coalesce(qual, '') || coalesce(with_check, ''), '''owner''::app_role') = 0;
  IF _n > 0 THEN
    RAISE EXCEPTION '% write polic(ies) on role_permission_overrides do not ask for the owner', _n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'role_permission_overrides'
                    AND permissive = 'RESTRICTIVE'
                    AND policyname = 'two-step sign-in, when the user has it') THEN
    RAISE EXCEPTION 'role_permission_overrides is missing the two-step policy';
  END IF;
  IF has_table_privilege('anon', 'public.role_permission_overrides', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read role_permission_overrides';
  END IF;

  -- has_permission reads the stored set, keeps its guards, keeps anon out.
  SELECT p.prosrc INTO _src FROM pg_proc p WHERE p.oid = _fn;
  IF strpos(_src, 'public.role_permission_overrides') = 0 OR strpos(_src, 'public.permission_default(') = 0 THEN
    RAISE EXCEPTION 'has_permission does not read the stored set';
  END IF;
  IF strpos(_src, '_permission NOT IN (''manage_org_billing'', ''manage_franchise'')') = 0 THEN
    RAISE EXCEPTION 'has_permission lost the owner-only floor';
  END IF;
  IF strpos(_src, 'NOT s.active') = 0 OR strpos(_src, 'auth.uid()') = 0 OR strpos(_src, 'mfa_satisfied()') = 0 THEN
    RAISE EXCEPTION 'has_permission lost its caller, second-step or turned-off guard';
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute has_permission';
  END IF;

  -- Every change is logged.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.role_permission_overrides'::regclass
                    AND tgname = 'role_permission_overrides_log_change' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'changes to role_permission_overrides are not logged';
  END IF;

  -- Staff authority asks the stored set and keeps the floors.
  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.set_staff_active(uuid, boolean)'::regprocedure);
  IF strpos(_src, '''manage_users''') = 0 OR strpos(_src, 'public.staff_row_is_an_owner(_staff_id)') = 0 THEN
    RAISE EXCEPTION 'set_staff_active does not read manage_users within the owner floor';
  END IF;
  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.change_user_role(uuid, uuid, app_role)'::regprocedure);
  IF strpos(_src, '''manage_users''') = 0 OR strpos(_src, 'public.caller_may_grant_role(') = 0
     OR strpos(_src, 'Only an owner can change the owner') = 0 THEN
    RAISE EXCEPTION 'change_user_role does not read manage_users within the owner floor';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'staff' AND permissive = 'RESTRICTIVE'
         AND policyname IN ('Whoever manages the team sets who is on; never the owner',
                            'Only an owner adds an owner',
                            'Only an owner removes a person')) <> 3 THEN
    RAISE EXCEPTION 'staff is missing one of the three restrictive staff-authority policies';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'staff'
                AND policyname = 'Owner or office manager sets who is on; never the owner') THEN
    RAISE EXCEPTION 'the role-named UPDATE policy is still on staff';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('set_staff_active', 'change_user_role', 'caller_may_grant_role', 'role_rank', 'permission_default')) <> 5 THEN
    RAISE EXCEPTION 'a staff-authority or permission function has an overload this body does not cover';
  END IF;

  -- Completing and canceling from the office ask close_visits, and no
  -- longer let any writer of the business through.
  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.office_complete_visit(uuid, text)'::regprocedure);
  IF strpos(_src, '''close_visits''') = 0 OR strpos(_src, 'can_write_org') > 0 THEN
    RAISE EXCEPTION 'office_complete_visit does not ask for close_visits';
  END IF;
  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.office_skip_visit(uuid, text, public.skip_reason_code, timestamptz)'::regprocedure);
  IF strpos(_src, '''close_visits''') = 0 OR strpos(_src, 'can_write_org') > 0 THEN
    RAISE EXCEPTION 'office_skip_visit does not ask for close_visits';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('office_complete_visit', 'office_skip_visit')) <> 2 THEN
    RAISE EXCEPTION 'office_complete_visit or office_skip_visit has an overload this body does not cover';
  END IF;
  -- Prepaid is not a dispatcher's: the plan write policies still ask for
  -- manage_pricing (established by 20260801090000 / 20260810120000, not
  -- touched here), and the prepaid invoice RPC for manage_client_billing.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'subscriptions' AND permissive = 'PERMISSIVE'
         AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
         AND strpos(coalesce(qual, '') || coalesce(with_check, ''), 'manage_pricing') = 0) > 0 THEN
    RAISE EXCEPTION 'a subscriptions write policy no longer requires manage_pricing';
  END IF;
  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.generate_prepaid_invoice(uuid, integer)'::regprocedure);
  IF strpos(_src, '''manage_client_billing''') = 0 THEN
    RAISE EXCEPTION 'generate_prepaid_invoice no longer asks for manage_client_billing';
  END IF;

  -- A technician's code is for the assigned day.
  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.property_access_codes(uuid[])'::regprocedure);
  IF _src NOT LIKE '%''tech''::public.app_role%' OR _src NOT LIKE '%scheduled_on%' THEN
    RAISE EXCEPTION 'property_access_codes does not keep a technician to the assigned day';
  END IF;
  _src := (SELECT prosrc FROM pg_proc WHERE oid = 'public.stay_access_codes(uuid[])'::regprocedure);
  IF _src NOT LIKE '%''tech''::public.app_role%' OR _src NOT LIKE '%stay.access_viewed%' THEN
    RAISE EXCEPTION 'stay_access_codes does not keep a technician to their days, or stopped logging';
  END IF;
END
$post$;
