-- Three functions were live in production and defined in no migration.
--
-- Found while auditing the BUILD-6 franchise money paths: the comment at the
-- top of 20260731092000_franchise-payment-routing.sql says
--
--     set_chargeback_responsibility(child, mode)  — 20260730200000
--
-- and 20260730200000_franchise-settlement-both-directions.sql defines exactly
-- one function, generate_franchise_settlements. The pointer was wrong. This is
-- the fourth untrue comment this cycle to be treated as a source before being
-- checked, so the sweep below was run against the whole schema rather than the
-- one function: of 158 functions in `public`, three appear in no migration.
--
-- scripts/check-migrations.mjs does not catch this. It compares migration FILES
-- to Supabase's applied ledger, which answers "did the database run everything
-- the repo has". It cannot answer "does the database have something the repo
-- never wrote" — and that is the direction that bites, because the missing
-- object is invisible until an environment is rebuilt. A companion check ships
-- alongside this migration.
--
-- ── 1. set_chargeback_responsibility — RESTORED VERBATIM ───────────────────
--
-- Decides who absorbs a chargeback: the location, the franchise, or a split by
-- royalty percent. record_franchise_adjustment reads
-- organizations.chargeback_responsibility to divide every disputed dollar, and
-- setLocationChargebackPolicy on the payment-routing screen is the only way to
-- set it. A rebuilt database would have had the screen call a function that
-- does not exist.
--
-- Its authorization was checked before filing and is correct: owner of the
-- PARENT only, matching set_child_royalty_percent and
-- set_location_payment_routing. The body below is the live definition, byte for
-- byte — this migration records what is running, it does not change it.
--
-- ── 2. rls_auto_enable + the ensure_rls event trigger — RESTORED ───────────
--
-- Enables row level security on every new table created in `public`. It is a
-- safety net, and a load-bearing one for a codebase where four separate bugs
-- this cycle were "the routine was guarded and the table underneath was open".
-- A rebuilt environment without it would let the next new table ship readable
-- by every signed-in user, silently.
--
-- CREATE EVENT TRIGGER needs rights a migration role may not have, so it is
-- attempted and warned about rather than fatal — the function is the part this
-- migration can guarantee.
--
-- ── 3. email_queue_wake — DROPPED ──────────────────────────────────────────
--
-- Left over from the Lovable scaffold. On every invocation it POSTed to
--
--     https://project--da34c6c7-...-.lovable.app/lovable/email/queue/process
--
-- with `Authorization: Bearer <service_role key from vault>`. That is this
-- project's own former preview host, not anything HoundStack runs, and a
-- service_role key bypasses every RLS policy in this database.
--
-- It is inert today, and all three reasons were checked rather than assumed:
--
--   * no trigger references it — pg_trigger join on tgfoid returns nothing;
--   * it RETURNS trigger, so Postgres refuses a direct call regardless of the
--     EXECUTE grant it holds for `authenticated`;
--   * the vault secret it reads, 'email_queue_service_role_key', does not
--     exist — vault.secrets has zero rows by that name.
--
-- So this is not an incident. It is a loaded gun in the schema: any future
-- trigger wired to it would begin shipping a service_role key to a third-party
-- host. The live 'process-email-queue' cron job already points at
-- www.app.houndstack.com and is untouched by this.
--
-- The full body is preserved above in prose so the drop is reversible from
-- this file alone.

-- ── 1 ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_chargeback_responsibility(_child_org_id uuid, _responsibility text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _parent uuid;
BEGIN
  IF _responsibility NOT IN ('location','franchise','split') THEN
    RAISE EXCEPTION 'Responsibility must be location, franchise, or split.';
  END IF;
  SELECT parent_organization_id INTO _parent FROM public.organizations WHERE id = _child_org_id;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'That organization is not part of a franchise.';
  END IF;
  IF NOT public.has_role(auth.uid(), _parent, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the franchise owner can set who absorbs chargebacks.';
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);
  UPDATE public.organizations SET chargeback_responsibility = _responsibility WHERE id = _child_org_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_chargeback_responsibility(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_chargeback_responsibility(uuid, text) TO authenticated, service_role;

-- ── 2 ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ensure_rls') THEN
    EXECUTE 'CREATE EVENT TRIGGER ensure_rls ON ddl_command_end EXECUTE FUNCTION public.rls_auto_enable()';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'ensure_rls event trigger not created (needs superuser). New tables will NOT get RLS automatically in this environment.';
END $$;

-- ── 3 ──────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.email_queue_wake();

DO $$
DECLARE _present text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'email_queue_wake') THEN
    RAISE EXCEPTION 'email_queue_wake survived the drop';
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO _present
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('set_chargeback_responsibility', 'rls_auto_enable');
  IF _present IS DISTINCT FROM 'rls_auto_enable, set_chargeback_responsibility' THEN
    RAISE EXCEPTION 'both restored functions should exist, found: %', coalesce(_present, '<none>');
  END IF;
END $$;
