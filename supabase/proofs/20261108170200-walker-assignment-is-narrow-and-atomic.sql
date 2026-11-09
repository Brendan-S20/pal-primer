-- Proof for 20261108170200 — walker assignment is narrow and atomic (#731).
--
-- Run by the database job in .github/workflows/sandboxes.yml ("The proofs,
-- which are evidence rather than schema") against the database it has just
-- replayed from every migration. Locally:
--   supabase db reset
--   psql "postgresql://postgres:postgres@127.0.0.1:54422/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/proofs/20261108170200-walker-assignment-is-narrow-and-atomic.sql
--
-- Every assertion acts as the `authenticated` ROLE with a signed-in user's
-- claims, so RLS is live (README: setting the claims alone leaves you as
-- postgres, which bypasses it).
--
--   1. A dispatcher's plain UPDATE of a plan's walker matches no row (the
--      fault: the manage_pricing policy), and neither does a price change.
--   2. Through set_plan_walker the same dispatcher sets and clears the walker,
--      and the plan's price is untouched.
--   3. A tech, another business's dispatcher and anon are refused; a walker
--      from another business, or one who does not run routes, is refused.
--   4. assign_walk_group_if_open assigns an open group and copies the walker
--      onto its walks; leaves a group with a walk held by hand, or pinned,
--      exactly as it was; refuses a tech and another business.
--   5. Mutation: the old capacity write (a plain UPDATE of the group row
--      guarded only by its own walker being empty) DOES replace the hand
--      assignment that 4 kept. If it does not, 4 proved nothing.
--
-- The interleaved, two-session case (a hand assignment committed between the
-- read and the write, and one arriving during it) needs two connections and
-- is tests/integration/walker-assignment-is-narrow-and-atomic.db.test.ts,
-- which the same job runs.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

BEGIN;

-- ── Fixture ───────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a7330000-0000-4000-8000-0000000000a1', 'owner-p@walker-narrow.proof.invalid'),
  ('a7330000-0000-4000-8000-0000000000a2', 'dispatch-p@walker-narrow.proof.invalid'),
  ('a7330000-0000-4000-8000-0000000000a3', 'ann@walker-narrow.proof.invalid'),
  ('a7330000-0000-4000-8000-0000000000a4', 'bo@walker-narrow.proof.invalid'),
  ('a7330000-0000-4000-8000-0000000000a5', 'cy@walker-narrow.proof.invalid'),
  ('a7330000-0000-4000-8000-0000000000b1', 'dispatch-q@walker-narrow.proof.invalid'),
  ('a7330000-0000-4000-8000-0000000000b2', 'walker-q@walker-narrow.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, work_days, service_lines) VALUES
  ('07330000-0000-4000-8000-0000000000aa', 'Walker Narrow Proof P', 'America/Chicago', '{0,1,2,3,4,5,6}', '{dog_walking}'),
  ('07330000-0000-4000-8000-0000000000bb', 'Walker Narrow Proof Q', 'America/Chicago', '{0,1,2,3,4,5,6}', '{dog_walking}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a7330000-0000-4000-8000-0000000000a1', '07330000-0000-4000-8000-0000000000aa', 'owner'),
  ('a7330000-0000-4000-8000-0000000000a2', '07330000-0000-4000-8000-0000000000aa', 'dispatcher'),
  ('a7330000-0000-4000-8000-0000000000a3', '07330000-0000-4000-8000-0000000000aa', 'tech'),
  ('a7330000-0000-4000-8000-0000000000a4', '07330000-0000-4000-8000-0000000000aa', 'tech'),
  ('a7330000-0000-4000-8000-0000000000a5', '07330000-0000-4000-8000-0000000000aa', 'tech'),
  ('a7330000-0000-4000-8000-0000000000b1', '07330000-0000-4000-8000-0000000000bb', 'dispatcher'),
  ('a7330000-0000-4000-8000-0000000000b2', '07330000-0000-4000-8000-0000000000bb', 'tech');
SET LOCAL app.allow_protected_org_write = '';

-- Ann and Bo walk for P; Cy is on P's staff but does not run routes; Quinn
-- walks for Q.
INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active,
                          is_field_tech, is_field_tech_overridden) VALUES
  ('5e733000-0000-4000-8000-0000000000a3', '07330000-0000-4000-8000-0000000000aa',
   'a7330000-0000-4000-8000-0000000000a3', 'tech', 'Ann Narrow', true, true, true),
  ('5e733000-0000-4000-8000-0000000000a4', '07330000-0000-4000-8000-0000000000aa',
   'a7330000-0000-4000-8000-0000000000a4', 'tech', 'Bo Narrow', true, true, true),
  ('5e733000-0000-4000-8000-0000000000a5', '07330000-0000-4000-8000-0000000000aa',
   'a7330000-0000-4000-8000-0000000000a5', 'tech', 'Cy Narrow', true, false, true),
  ('5e733000-0000-4000-8000-0000000000b2', '07330000-0000-4000-8000-0000000000bb',
   'a7330000-0000-4000-8000-0000000000b2', 'tech', 'Quinn Narrow', true, true, true);

INSERT INTO public.services (id, organization_id, name, service_line, price_unit,
                             base_price_cents, extra_pet_cents, default_duration_min, max_dogs, active) VALUES
  ('55733000-0000-4000-8000-0000000000a1', '07330000-0000-4000-8000-0000000000aa',
   'Narrow pack walk', 'dog_walking', 'visit', 2000, 0, 60, 6, true);

CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT (now() AT TIME ZONE 'America/Chicago')::date + 20 AS d;
GRANT SELECT ON proof_day TO authenticated, anon;

-- Four clients in P, a plan each, a visit each on D.
INSERT INTO public.clients (id, organization_id, account_type, display_name)
SELECT ('c7330000-0000-4000-8000-0000000000a' || k)::uuid, '07330000-0000-4000-8000-0000000000aa',
       'residential', 'Narrow Client ' || k
  FROM unnest(ARRAY['1','2','3','4']) AS k;
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code)
SELECT ('e7330000-0000-4000-8000-0000000000a' || k)::uuid, '07330000-0000-4000-8000-0000000000aa',
       ('c7330000-0000-4000-8000-0000000000a' || k)::uuid, k || ' Narrow St', 'Chicago', '60614'
  FROM unnest(ARRAY['1','2','3','4']) AS k;
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, service_id)
SELECT ('d7330000-0000-4000-8000-0000000000a' || k)::uuid, '07330000-0000-4000-8000-0000000000aa',
       ('c7330000-0000-4000-8000-0000000000a' || k)::uuid,
       ('e7330000-0000-4000-8000-0000000000a' || k)::uuid,
       'residential', 'weekly', 2600, 1, p.d + 60, '55733000-0000-4000-8000-0000000000a1'
  FROM proof_day p, unnest(ARRAY['1','2','3','4']) AS k;
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, service_id,
                           scheduled_on, status)
SELECT ('f7330000-0000-4000-8000-0000000000a' || k)::uuid, '07330000-0000-4000-8000-0000000000aa',
       ('d7330000-0000-4000-8000-0000000000a' || k)::uuid,
       ('c7330000-0000-4000-8000-0000000000a' || k)::uuid,
       ('e7330000-0000-4000-8000-0000000000a' || k)::uuid,
       '55733000-0000-4000-8000-0000000000a1', p.d, 'scheduled'
  FROM proof_day p, unnest(ARRAY['1','2','3','4']) AS k;

-- Three groups on D, none with a walker: OPEN takes walk 1; HELD takes walk 2,
-- which Ann then holds by hand; PINNED takes walk 3, held by Ann and pinned.
INSERT INTO public.walk_groups (id, organization_id, service_id, scheduled_on)
SELECT x.id::uuid, '07330000-0000-4000-8000-0000000000aa', '55733000-0000-4000-8000-0000000000a1', p.d
  FROM proof_day p, (VALUES
    ('97330000-0000-4000-8000-0000000000c1'),
    ('97330000-0000-4000-8000-0000000000c2'),
    ('97330000-0000-4000-8000-0000000000c3')) AS x(id);
UPDATE public.visits SET walk_group_id = '97330000-0000-4000-8000-0000000000c1'
 WHERE id = 'f7330000-0000-4000-8000-0000000000a1';
UPDATE public.visits SET walk_group_id = '97330000-0000-4000-8000-0000000000c2'
 WHERE id = 'f7330000-0000-4000-8000-0000000000a2';
UPDATE public.visits SET walk_group_id = '97330000-0000-4000-8000-0000000000c3'
 WHERE id = 'f7330000-0000-4000-8000-0000000000a3';
UPDATE public.visits SET assigned_staff_id = '5e733000-0000-4000-8000-0000000000a3'
 WHERE id = 'f7330000-0000-4000-8000-0000000000a2';
UPDATE public.visits SET assigned_staff_id = '5e733000-0000-4000-8000-0000000000a3', route_pinned = true
 WHERE id = 'f7330000-0000-4000-8000-0000000000a3';

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

DO $$
BEGIN
  IF current_setting('app.allow_protected_org_write', true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'PROOF FAILED [fixture]: the protected-org hatch is still open';
  END IF;
END $$;

-- ── 1. The dispatcher's plain UPDATE: the fault, and the fence ────────────
SELECT pg_temp.as_user('a7330000-0000-4000-8000-0000000000a2');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n int;
BEGIN
  UPDATE public.subscriptions SET assigned_staff_id = '5e733000-0000-4000-8000-0000000000a3'
   WHERE id = 'd7330000-0000-4000-8000-0000000000a1';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [policy]: a dispatcher''s plain UPDATE of a plan matched % row(s); the manage_pricing policy is not what this proof assumed', _n;
  END IF;
  UPDATE public.subscriptions SET price_cents = 1 WHERE id = 'd7330000-0000-4000-8000-0000000000a1';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [policy]: a dispatcher repriced a plan';
  END IF;
  RAISE NOTICE 'ok: a dispatcher''s plain UPDATE of a plan, walker or price, matches nothing (manage_pricing)';
END $$;

-- ── 2. set_plan_walker: the dispatcher saves, and only the walker ─────────
DO $$
BEGIN
  PERFORM public.set_plan_walker('d7330000-0000-4000-8000-0000000000a1', '5e733000-0000-4000-8000-0000000000a3');
END $$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT assigned_staff_id FROM public.subscriptions WHERE id = 'd7330000-0000-4000-8000-0000000000a1')
     IS DISTINCT FROM '5e733000-0000-4000-8000-0000000000a3'
    OR (SELECT price_cents FROM public.subscriptions WHERE id = 'd7330000-0000-4000-8000-0000000000a1') <> 2600 THEN
    RAISE EXCEPTION 'PROOF FAILED [save]: the dispatcher''s walker did not save, or the price moved';
  END IF;
END $$;
SELECT pg_temp.as_user('a7330000-0000-4000-8000-0000000000a2');
SET LOCAL ROLE authenticated;
DO $$ BEGIN PERFORM public.set_plan_walker('d7330000-0000-4000-8000-0000000000a1', NULL); END $$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT assigned_staff_id FROM public.subscriptions WHERE id = 'd7330000-0000-4000-8000-0000000000a1') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [clear]: the dispatcher could not clear the walker';
  END IF;
  RAISE NOTICE 'ok: a dispatcher sets and clears a plan''s walker through set_plan_walker, and the price stays 2600';
END $$;

-- ── 3. Who is refused ─────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.refused(_uid text, _sub uuid, _walker uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.as_user(_uid);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.set_plan_walker(_sub, _walker);
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RESET ROLE;
    RETURN SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN NULL;
END $$;
DO $$
DECLARE _r text;
BEGIN
  -- A tech in the same business.
  _r := pg_temp.refused('a7330000-0000-4000-8000-0000000000a3', 'd7330000-0000-4000-8000-0000000000a1',
                        '5e733000-0000-4000-8000-0000000000a3');
  IF _r IS DISTINCT FROM '42501 Not authorized' THEN
    RAISE EXCEPTION 'PROOF FAILED [tech]: a tech setting a plan''s walker got %', _r;
  END IF;
  -- Another business's dispatcher.
  _r := pg_temp.refused('a7330000-0000-4000-8000-0000000000b1', 'd7330000-0000-4000-8000-0000000000a1',
                        '5e733000-0000-4000-8000-0000000000b2');
  IF _r IS DISTINCT FROM '42501 Not authorized' THEN
    RAISE EXCEPTION 'PROOF FAILED [tenant]: another business''s dispatcher got %', _r;
  END IF;
  -- P's dispatcher naming Q's walker, or P's Cy who does not run routes.
  _r := pg_temp.refused('a7330000-0000-4000-8000-0000000000a2', 'd7330000-0000-4000-8000-0000000000a1',
                        '5e733000-0000-4000-8000-0000000000b2');
  IF _r IS DISTINCT FROM '23514 Choose a walker from this business.' THEN
    RAISE EXCEPTION 'PROOF FAILED [walker-tenant]: another business''s walker got %', _r;
  END IF;
  _r := pg_temp.refused('a7330000-0000-4000-8000-0000000000a2', 'd7330000-0000-4000-8000-0000000000a1',
                        '5e733000-0000-4000-8000-0000000000a5');
  IF _r NOT LIKE '23514 Cy Narrow is not set up to run routes.%' THEN
    RAISE EXCEPTION 'PROOF FAILED [runs-routes]: a walker who does not run routes got %', _r;
  END IF;
  IF (SELECT assigned_staff_id FROM public.subscriptions WHERE id = 'd7330000-0000-4000-8000-0000000000a1') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [refused]: a refused call still changed the plan';
  END IF;
  IF has_function_privilege('anon', 'public.set_plan_walker(uuid, uuid)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.assign_walk_group_if_open(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [anon]: anon can call a walker function';
  END IF;
  RAISE NOTICE 'ok: a tech, another business, anon, a foreign walker and a walker who does not run routes are all refused';
END $$;

-- ── 4. assign_walk_group_if_open ──────────────────────────────────────────
CREATE TEMP TABLE outcomes (k text PRIMARY KEY, v text) ON COMMIT DROP;
GRANT ALL ON outcomes TO authenticated;
SELECT pg_temp.as_user('a7330000-0000-4000-8000-0000000000a2');
SET LOCAL ROLE authenticated;
-- One statement each, in this order: 'again' depends on 'open' having run.
INSERT INTO outcomes VALUES ('open',   public.assign_walk_group_if_open('97330000-0000-4000-8000-0000000000c1', '5e733000-0000-4000-8000-0000000000a4'));
INSERT INTO outcomes VALUES ('held',   public.assign_walk_group_if_open('97330000-0000-4000-8000-0000000000c2', '5e733000-0000-4000-8000-0000000000a4'));
INSERT INTO outcomes VALUES ('pinned', public.assign_walk_group_if_open('97330000-0000-4000-8000-0000000000c3', '5e733000-0000-4000-8000-0000000000a4'));
INSERT INTO outcomes VALUES ('again',  public.assign_walk_group_if_open('97330000-0000-4000-8000-0000000000c1', '5e733000-0000-4000-8000-0000000000a3'));
RESET ROLE;
DO $$
DECLARE _r text;
BEGIN
  IF (SELECT string_agg(k || '=' || v, ',' ORDER BY k) FROM outcomes)
     IS DISTINCT FROM 'again=has_walker,held=members_assigned,open=assigned,pinned=members_assigned' THEN
    RAISE EXCEPTION 'PROOF FAILED [capacity]: outcomes were %', (SELECT string_agg(k || '=' || v, ',' ORDER BY k) FROM outcomes);
  END IF;
  IF (SELECT assigned_staff_id FROM public.visits WHERE id = 'f7330000-0000-4000-8000-0000000000a1')
     IS DISTINCT FROM '5e733000-0000-4000-8000-0000000000a4' THEN
    RAISE EXCEPTION 'PROOF FAILED [capacity]: the open group''s walk did not take Bo';
  END IF;
  IF (SELECT assigned_staff_id FROM public.visits WHERE id = 'f7330000-0000-4000-8000-0000000000a2')
     IS DISTINCT FROM '5e733000-0000-4000-8000-0000000000a3'
    OR (SELECT assigned_staff_id FROM public.visits WHERE id = 'f7330000-0000-4000-8000-0000000000a3')
     IS DISTINCT FROM '5e733000-0000-4000-8000-0000000000a3'
    OR NOT (SELECT route_pinned FROM public.visits WHERE id = 'f7330000-0000-4000-8000-0000000000a3')
    OR (SELECT count(*) FROM public.walk_groups
         WHERE id IN ('97330000-0000-4000-8000-0000000000c2', '97330000-0000-4000-8000-0000000000c3')
           AND assigned_staff_id IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [capacity]: a walk held or pinned by hand was changed';
  END IF;

  -- A tech, and another business's dispatcher.
  FOREACH _r IN ARRAY ARRAY['a7330000-0000-4000-8000-0000000000a3', 'a7330000-0000-4000-8000-0000000000b1'] LOOP
    PERFORM pg_temp.as_user(_r);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.assign_walk_group_if_open('97330000-0000-4000-8000-0000000000c2', '5e733000-0000-4000-8000-0000000000a4');
      RESET ROLE;
      RAISE EXCEPTION 'PROOF FAILED [capacity-auth]: % assigned a group', _r;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
    END;
  END LOOP;
  RAISE NOTICE 'ok: assign_walk_group_if_open assigns the open group, keeps held and pinned walks, and refuses a tech and another business';
END $$;

-- ── 5. Mutation: the old capacity write replaces the hand assignment ──────
-- The write Assign by capacity used before this migration, as the same
-- dispatcher: the group row, guarded only by its own walker being empty.
-- copy_walk_group_walker then writes Bo over Ann on the held walk. This is
-- what step 4 refused to do; if the old write does NOT do it, step 4 kept the
-- walk for some other reason and proved nothing.
SELECT pg_temp.as_user('a7330000-0000-4000-8000-0000000000a2');
SET LOCAL ROLE authenticated;
UPDATE public.walk_groups SET assigned_staff_id = '5e733000-0000-4000-8000-0000000000a4'
 WHERE id = '97330000-0000-4000-8000-0000000000c2' AND assigned_staff_id IS NULL;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT assigned_staff_id FROM public.visits WHERE id = 'f7330000-0000-4000-8000-0000000000a2')
     IS DISTINCT FROM '5e733000-0000-4000-8000-0000000000a4' THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: the old capacity write did not replace the hand assignment';
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: the old write puts Bo over Ann''s hand-held walk';
END $$;

ROLLBACK;
\echo ALL WALKER ASSIGNMENT PROOFS PASSED
