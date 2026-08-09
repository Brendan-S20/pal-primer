-- An org-level switch for the commercial-account machinery.
--
-- The complaint this answers: a person with two trucks and forty residential
-- driveways should not have to learn what a "unit roster" or a "waste station
-- section" is in order to use the product. The eleven-reviewer audit called
-- this the niche problem.
--
-- ── WHAT THE AUDIT GOT WRONG, AND WHY THIS IS SMALLER THAN IT SOUNDS ──────
--
-- The audit said commercial features are "always visible". Mostly they are
-- not. The heavy surfaces already branch on `account_type` and a purely
-- residential org sees none of them today: the Units tab, the stations panel,
-- the commercial pricing breakdown, the per-property commercial fields, and
-- the tech's station checklist are all already conditional.
--
-- What is genuinely unconditional is small — the account-type pickers, the
-- /dna nav entry, the zone drawer's commercial pricing block (shown by
-- default because the zone type defaults to "all"), and the clients-list type
-- filter. So this flag is a tidy-up with a switch, not a new subsystem.
--
-- It also said to "copy the franchise pattern exactly". That would be a
-- mistake: franchise is a PLAN ENTITLEMENT derived from platform_plans and
-- available on the enterprise tier only. Copying it exactly would make
-- commercial accounts a paid upsell — a pricing commitment published on the
-- marketing site and guarded by tests/entitlement-parity.test.ts. This copies
-- `seasonal_deepclean_enabled` instead: an owner-writable boolean on
-- organizations, which is what this actually is.
--
-- Deliberately NOT added to tg_orgs_protect_platform_columns. That trigger
-- guards columns the platform sells (ai_receptionist_enabled and friends);
-- this one is the owner's own preference about their own screens.
--
-- ── DEFAULT FALSE, BUT NOT FOR EVERYONE ──────────────────────────────────
--
-- New organizations start with it off. Existing ones do not, and the
-- difference matters more than it looks: switching it off for an org that
-- already has commercial clients would hide the Units tab (and with it
-- unit_incidents, which carry real charges), the stations panel and its
-- proof-of-service log, the DNA workspace where violation fines live, and the
-- per-property total_units field that active-subscription repricing reads —
-- so a growing HOA would keep billing yesterday's unit count forever, with no
-- error anywhere.
--
-- So the backfill turns it ON wherever any commercial data exists. Checked
-- against live data before writing this: 3 organizations, all of them demo
-- orgs, and all 3 qualify — 23 commercial clients, 14 commercial properties,
-- 45 waste stations, 23 active commercial subscriptions between them. There
-- are no paying tenants yet, so nothing here can strand a real operator; the
-- backfill exists because that will not be true for long.
--
-- Turning it off later is refused while commercial data exists, for the same
-- reason. That is enforced in set_org_commercial_accounts below rather than
-- in a CHECK, because the answer depends on other tables.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS commercial_accounts boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.commercial_accounts IS
  'Owner-set: does this business serve commercial accounts (HOAs, apartment complexes, dog parks)? Off hides the unit/station/DNA machinery from THIS ORG''S STAFF screens only. Never gates the client portal, and never gates a write path — see the migration header.';

-- ── Backfill: nobody loses a screen they are already using ────────────────
UPDATE public.organizations o
   SET commercial_accounts = true
 WHERE NOT o.commercial_accounts
   AND (
     EXISTS (SELECT 1 FROM public.clients c
              WHERE c.organization_id = o.id AND c.account_type = 'commercial')
     OR EXISTS (SELECT 1 FROM public.properties p
                 WHERE p.organization_id = o.id
                   AND (p.account_type = 'commercial' OR p.has_units))
     OR EXISTS (SELECT 1 FROM public.property_units u WHERE u.organization_id = o.id)
     OR EXISTS (SELECT 1 FROM public.waste_stations w WHERE w.organization_id = o.id)
     OR EXISTS (SELECT 1 FROM public.clients c
                 WHERE c.organization_id = o.id AND c.dna_compliance_enabled)
   );

-- ── Does this org have commercial data? ───────────────────────────────────
-- One definition, used by the setter's refusal and by the UI's explanation of
-- why the switch is stuck. Two copies of this predicate would eventually
-- disagree and the UI would offer a toggle the server then rejects.
CREATE OR REPLACE FUNCTION public.org_has_commercial_data(_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT
     EXISTS (SELECT 1 FROM public.clients c
              WHERE c.organization_id = _org_id AND c.account_type = 'commercial')
  OR EXISTS (SELECT 1 FROM public.properties p
              WHERE p.organization_id = _org_id
                AND (p.account_type = 'commercial' OR p.has_units))
  OR EXISTS (SELECT 1 FROM public.property_units u WHERE u.organization_id = _org_id)
  OR EXISTS (SELECT 1 FROM public.waste_stations w WHERE w.organization_id = _org_id)
  OR EXISTS (SELECT 1 FROM public.clients c
              WHERE c.organization_id = _org_id AND c.dna_compliance_enabled);
$function$;

REVOKE ALL ON FUNCTION public.org_has_commercial_data(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.org_has_commercial_data(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_org_commercial_accounts(_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE _org uuid;
BEGIN
  SELECT ur.organization_id INTO _org
    FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
  IF _org IS NULL THEN RAISE EXCEPTION 'No organization'; END IF;
  IF NOT public.has_permission(auth.uid(), _org, 'manage_settings') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Refusing rather than warning. Switching this off with commercial clients
  -- on the books hides the screens where their units, stations, service proof
  -- and DNA fines live — none of which stop existing, and one of which
  -- (total_units) silently freezes their billing at its current figure.
  IF NOT _enabled AND public.org_has_commercial_data(_org) THEN
    RAISE EXCEPTION 'This account still has commercial clients, properties or stations. Move them to residential first, or leave commercial accounts switched on.';
  END IF;

  UPDATE public.organizations
     SET commercial_accounts = _enabled, updated_at = now()
   WHERE id = _org;

  RETURN jsonb_build_object('ok', true, 'commercial_accounts', _enabled);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_org_commercial_accounts(boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.set_org_commercial_accounts(boolean) TO authenticated;

DO $post$
DECLARE _off_with_data integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='organizations'
       AND column_name='commercial_accounts'
  ) THEN
    RAISE EXCEPTION 'commercial_accounts was not added';
  END IF;

  -- The backfill's whole job. If any org still reads false while holding
  -- commercial data, someone is about to lose a screen they use.
  SELECT count(*) INTO _off_with_data
    FROM public.organizations o
   WHERE NOT o.commercial_accounts AND public.org_has_commercial_data(o.id);
  IF _off_with_data <> 0 THEN
    RAISE EXCEPTION '% organization(s) have commercial data but the flag is off', _off_with_data;
  END IF;
END
$post$;
