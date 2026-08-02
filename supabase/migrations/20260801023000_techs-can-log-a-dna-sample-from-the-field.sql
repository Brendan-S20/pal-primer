-- Techs can log a DNA sample from the field (Q-5).
--
-- ── WHY THIS IS AN RPC AND NOT AN RLS POLICY ───────────────────────────────
--
-- The migration immediately before this one closed a hole where every policy
-- on dna_matches was `is_org_member` and a tech could re-point a $250
-- violation onto another client's dog, close it, and delete a sample sitting
-- at the lab. Re-opening INSERT to techs org-wide would hand back part of what
-- that just took away: a tech could file a sample against any property in the
-- organization, including one they have never visited.
--
-- An RLS policy also cannot easily express the thing that actually makes this
-- safe — "a visit assigned to ME, at THIS property, that I am doing" — without
-- a correlated subquery on every row. So the write goes through one
-- SECURITY DEFINER function that takes a VISIT, not a property: the tech names
-- work they are already assigned to, and organization, property, client and
-- unit are all DERIVED from that row rather than accepted from the caller.
--
-- ── WHAT A TECH CANNOT DO THROUGH IT ───────────────────────────────────────
--
-- The parameters are the whole allowlist. There is no fine_cents, no
-- matched_dog_id, no status, no client_id and no property_id, so none of them
-- can be supplied:
--
--   * a sample always lands at status 'new' — unprocessed, unmatched, unbilled
--   * it is always attributed to the caller's own staff row
--   * it always belongs to the visit's property and client
--
-- Matching it to a dog, pricing it, and billing it stay office actions behind
-- can_write_org and manage_dna_billing, exactly as before. This adds a way to
-- START the trail, not to decide its outcome.
--
-- ── WHY IT REFUSES CLIENTS NOT IN THE PROGRAMME ────────────────────────────
--
-- dna_compliance_enabled is a per-client flag the office sets, and it is the
-- reason a property is being sampled at all. Logging a sample against a client
-- who never opted in produces a record the office cannot act on and the client
-- never agreed to.

CREATE OR REPLACE FUNCTION public.log_dna_sample_from_field(
  _visit_id uuid,
  _sample_kind text DEFAULT 'pile_sample',
  _location_note text DEFAULT NULL,
  _unit_id uuid DEFAULT NULL,
  _sample_photo_path text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _prop uuid; _client uuid; _staff uuid; _enabled boolean; _row uuid;
BEGIN
  -- The one gate. is_visit_tech is true only when the caller IS the visit's
  -- assigned tech — the same primitive start_visit and complete_visit use.
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'You can only log a sample on a visit assigned to you';
  END IF;

  SELECT v.organization_id, v.property_id, v.client_id, v.assigned_staff_id
    INTO _org, _prop, _client, _staff
    FROM public.visits v WHERE v.id = _visit_id;

  IF _sample_kind NOT IN ('cheek_swab', 'pile_sample') THEN
    RAISE EXCEPTION 'Unknown sample kind';
  END IF;

  SELECT c.dna_compliance_enabled INTO _enabled
    FROM public.clients c WHERE c.id = _client;
  IF NOT COALESCE(_enabled, false) THEN
    RAISE EXCEPTION 'This client is not on the DNA compliance programme';
  END IF;

  -- A unit, if given, must belong to the visit's own property. The table's
  -- validate trigger checks this too; failing here gives the tech a sentence
  -- they can act on instead of a constraint name.
  IF _unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.property_units u
     WHERE u.id = _unit_id AND u.property_id = _prop
  ) THEN
    RAISE EXCEPTION 'That unit is not at this property';
  END IF;

  -- Storage paths are org-scoped; anything else would let one tenant's path be
  -- written onto another's record. Mirrors the check in createDnaMatch.
  IF _sample_photo_path IS NOT NULL AND _sample_photo_path NOT LIKE _org::text || '/%' THEN
    RAISE EXCEPTION 'Sample photo is not in this organization''s storage';
  END IF;

  INSERT INTO public.dna_matches (
    organization_id, property_id, client_id, unit_id,
    sample_kind, status, location_note, collected_by_staff_id, sample_photo_path
  )
  VALUES (
    _org, _prop, _client, _unit_id,
    _sample_kind, 'new', NULLIF(btrim(COALESCE(_location_note, '')), ''), _staff, _sample_photo_path
  )
  RETURNING id INTO _row;

  RETURN _row;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.log_dna_sample_from_field(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_dna_sample_from_field(uuid, text, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.log_dna_sample_from_field(uuid, text, text, uuid, text) IS
  'Field DNA sample logging for the visit''s ASSIGNED TECH only. Derives org/property/client from the visit; cannot set fine, match or status. Q-5.';
