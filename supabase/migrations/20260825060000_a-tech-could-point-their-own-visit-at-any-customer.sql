-- A technician could point their own visit at any customer in the org, read
-- back that customer's gate code, and put a charge on the invoice.
--
-- ── THE HOLE ──────────────────────────────────────────────────────────────
--
-- "Techs update own visits" (20260809200000, line 697) constrains WHICH ROWS a
-- technician may update:
--
--   USING      (has_role(uid, organization_id, 'tech')
--               AND assigned_staff_id IN (SELECT id FROM staff WHERE user_id = uid))
--   WITH CHECK (… the same …)
--
-- It says nothing about WHICH COLUMNS, because RLS cannot: a policy is a row
-- predicate. The table grant is the whole table --
-- `GRANT SELECT, INSERT, UPDATE, DELETE ON public.visits TO authenticated`
-- (20260701161233, line 68) -- with no column list, and there is no
-- column-level GRANT UPDATE anywhere in this repository to narrow it.
--
-- Nothing else stood in the way either. public.visits carried exactly two
-- triggers before this file: trg_visits_touch (BEFORE UPDATE, stamps
-- updated_at) and visits_respect_time_off (BEFORE INSERT OR UPDATE **OF
-- assigned_staff_id, scheduled_on**). Neither fires on a write to client_id.
--
-- So a technician could set any column on a visit that was legitimately
-- theirs, and the two that matter are client_id and property_id.
--
-- ── WHY THAT IS WORSE THAN IT SOUNDS ──────────────────────────────────────
--
-- 20260804090000_a-tech-could-read-every-customer-in-the-org.sql narrowed
-- customer reads to may_read_client, which grants access on:
--
--   EXISTS (SELECT 1 FROM visits v JOIN staff s ON …
--            WHERE v.client_id = c.id AND s.user_id = auth.uid())
--
-- "does this user have a visit for this client". The technician decides the
-- answer. One PATCH against PostgREST with the publishable key from the app
-- bundle and their own session:
--
--   PATCH /rest/v1/visits?id=eq.<their own visit>
--   { "client_id": "<any client>", "property_id": "<that client's property>" }
--
-- WITH CHECK still passes -- assigned_staff_id never moved. getVisitDetail
-- then returns that customer's phone, email and credit_balance_cents, and the
-- property's gate_code, lock_box_code, key_location and access_notes. Loop it
-- over every client id (a plain SELECT on visits is gated on bare
-- is_org_member, so the ids are already readable), then set it back.
--
-- The gate codes and lock-box codes for every property the business services.
--
-- ── THE MONEY HALF, AND A CORRECTION TO THE REPORT THAT FOUND THIS ────────
--
-- The audit that surfaced this said a technician could also set price_cents on
-- their own visit. **public.visits has no price_cents column.** A visit's price
-- comes from its subscription -- `SELECT s.price_cents FROM visits v JOIN
-- subscriptions s ON s.id = v.subscription_id` (20260701170254, line 69) -- and
-- subscriptions are not writable by a tech. That specific claim was wrong and
-- is recorded here as wrong.
--
-- It was wrong about the column and right about the exposure. Three money
-- columns DO live on visits, and 20260731210000 lines 86-120 build invoice
-- line items directly from them:
--
--   skip_charge_cents        -- charged for a visit that did not happen
--   is_deepclean             -- selects the deep-clean line at all
--   deepclean_charge_cents   -- what that line bills
--
-- Nothing in src/ writes any of the three; they are set by SQL from the org's
-- own skip rules and seasonal settings. A technician writing them directly is
-- never a legitimate flow, so all three are protected below alongside the five
-- identity columns.
--
-- ── WHAT THIS DOES NOT BREAK, CHECKED RATHER THAN ASSUMED ─────────────────
--
--   * finalize_visit_completion (20260729100000, line 56) READS
--     subscription_id and client_id and writes none of them, so ordinary visit
--     completion is untouched.
--   * The technician's one permission is record_field_addons, and that flow
--     (src/lib/addons.functions.ts:169) reads the visit and writes to
--     addon_charges. It sets no column on visits at all.
--   * A tech's real writes -- status, started_at, completed_at, skip_reason,
--     skip_reason_code, skipped_at, station_count_serviced, travel_km,
--     travel_min, weather_flagged -- are all outside the protected set.
--   * assigned_staff_id and scheduled_on are deliberately NOT protected here.
--     They are already covered by the RLS policy and by visits_respect_time_off,
--     and dispatch legitimately moves them.
--
-- ── WHY auth.uid() IS NULL IS A PASS ──────────────────────────────────────
--
-- Service-role callers, pg_cron jobs and the nightly runner have no JWT, so
-- auth.uid() is NULL for them. They are the code that legitimately rewrites
-- these columns in bulk -- visit generation, zone reassignment, deep-clean
-- scheduling, tenant deletion. Blocking them would break the product to close
-- a hole they are not in. The gate is about a SIGNED-IN user without write
-- permission, which is exactly what auth.uid() being non-null identifies.
--
-- Note this is the same premise 20260820140000 relied on for post_credit_entry
-- and got half wrong: SECURITY DEFINER changes the privilege role but NOT
-- request.jwt.claims, so auth.uid() inside a definer function is still the
-- caller's. That is a real defect in that file (a tech cannot complete a
-- prepaid visit) and it is being verified separately. It does not affect this
-- trigger, because here the caller's identity is precisely what we want.

CREATE OR REPLACE FUNCTION public.visits_guard_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _changed text[] := ARRAY[]::text[];
BEGIN
  -- No JWT: service role, pg_cron, the nightly runner. See header.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Owner / office manager / dispatcher. The same gate the "Managers write
  -- visits" policy already uses, so this adds no new notion of who may write.
  IF public.can_write_org(auth.uid(), OLD.organization_id) THEN
    RETURN NEW;
  END IF;

  -- Tenancy and identity.
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    _changed := _changed || 'organization_id';
  END IF;
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    _changed := _changed || 'client_id';
  END IF;
  IF NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    _changed := _changed || 'property_id';
  END IF;
  IF NEW.subscription_id IS DISTINCT FROM OLD.subscription_id THEN
    _changed := _changed || 'subscription_id';
  END IF;
  IF NEW.zone_id IS DISTINCT FROM OLD.zone_id THEN
    _changed := _changed || 'zone_id';
  END IF;

  -- Money. These three become invoice line items; see header.
  IF NEW.skip_billable IS DISTINCT FROM OLD.skip_billable THEN
    _changed := _changed || 'skip_billable';
  END IF;
  IF NEW.skip_charge_cents IS DISTINCT FROM OLD.skip_charge_cents THEN
    _changed := _changed || 'skip_charge_cents';
  END IF;
  IF NEW.is_deepclean IS DISTINCT FROM OLD.is_deepclean THEN
    _changed := _changed || 'is_deepclean';
  END IF;
  IF NEW.deepclean_charge_cents IS DISTINCT FROM OLD.deepclean_charge_cents THEN
    _changed := _changed || 'deepclean_charge_cents';
  END IF;

  IF array_length(_changed, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Not authorized to change % on a visit.', array_to_string(_changed, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.visits_guard_privileged_columns() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS visits_guard_privileged_columns ON public.visits;
CREATE TRIGGER visits_guard_privileged_columns
  BEFORE UPDATE ON public.visits
  FOR EACH ROW
  EXECUTE FUNCTION public.visits_guard_privileged_columns();

-- ── VERIFICATION ─────────────────────────────────────────────────────────
--
-- Both of these are properties this file ESTABLISHES, so a replay into an
-- empty database can prove them from any starting state. Neither counts rows,
-- names a tenant, or assumes a cron schedule.
DO $verify$
DECLARE _cols text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.visits'::regclass
       AND t.tgname = 'visits_guard_privileged_columns'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'visits_guard_privileged_columns did not attach to public.visits';
  END IF;

  -- Every column the guard names must exist. A protected column that has been
  -- renamed away silently stops being protected, and the trigger body would
  -- not error -- NEW.<col> would simply never differ. This is the check that
  -- catches that, and it is why price_cents is NOT in the list: it is not a
  -- column on this table and never was.
  _cols := ARRAY['organization_id','client_id','property_id','subscription_id',
                 'zone_id','skip_billable','skip_charge_cents','is_deepclean',
                 'deepclean_charge_cents'];
  IF EXISTS (
    SELECT 1 FROM unnest(_cols) c
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = c
     )
  ) THEN
    RAISE EXCEPTION 'visits_guard_privileged_columns protects a column that does not exist on public.visits';
  END IF;
END
$verify$;
