-- A sitter knows who to call when a pet is sick (#411 review, blocker 3).
--
-- When a pet is sick and the client is on a plane, the sitter needs the vet
-- and someone who can say yes to treatment. pet_care_instructions holds
-- feeding, meds and other care only.
--
--   clients.emergency_contact_name, emergency_contact_phone
--   clients.emergency_contact_may_approve_vet   that person can approve vet care
--   clients.vet_treatment_limit_cents           what the sitter may spend on
--                                               treatment without asking
--   dogs.vet_clinic_name, vet_clinic_phone      each pet's vet
--
-- The limit is on the client rather than the stay: the office edits it in
-- the same form as the emergency contact, and it holds for every stay.
--
-- stay_contact_gaps(_stay_id) names what is missing for a stay:
-- 'emergency_contact', 'vet' (a pet on the stay with no clinic or phone) or
-- 'treatment_limit'. The office confirm form and the confirm and booking
-- server functions read it and warn. Nothing is refused: a stay can still be
-- confirmed without them. confirm_stay itself is unchanged, because a
-- Postgres WARNING never reaches the caller through the API.
--
-- clients and dogs keep their table grants, so the new columns read and
-- write like the others: the office edits them, and a sitter reads them
-- through the rows RLS already gives them.
--
-- Replays into an empty database: six columns and one function. No row is
-- needed and no number is asserted.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS emergency_contact_name text,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone text,
  ADD COLUMN IF NOT EXISTS emergency_contact_may_approve_vet boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vet_treatment_limit_cents integer;

ALTER TABLE public.dogs
  ADD COLUMN IF NOT EXISTS vet_clinic_name text,
  ADD COLUMN IF NOT EXISTS vet_clinic_phone text;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.clients'::regclass AND conname = 'clients_emergency_contact_check') THEN
    ALTER TABLE public.clients ADD CONSTRAINT clients_emergency_contact_check CHECK (
      (emergency_contact_name IS NULL OR char_length(emergency_contact_name) <= 200)
      AND (emergency_contact_phone IS NULL OR char_length(emergency_contact_phone) <= 40)
      AND (vet_treatment_limit_cents IS NULL OR vet_treatment_limit_cents BETWEEN 0 AND 10000000)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.dogs'::regclass AND conname = 'dogs_vet_clinic_check') THEN
    ALTER TABLE public.dogs ADD CONSTRAINT dogs_vet_clinic_check CHECK (
      (vet_clinic_name IS NULL OR char_length(vet_clinic_name) <= 200)
      AND (vet_clinic_phone IS NULL OR char_length(vet_clinic_phone) <= 40)
    );
  END IF;
END
$constraints$;

COMMENT ON COLUMN public.clients.emergency_contact_name IS
  'Who the sitter calls when the client cannot be reached. Migration 20261017020000.';
COMMENT ON COLUMN public.clients.emergency_contact_may_approve_vet IS
  'The emergency contact may approve vet care for the client''s pets. Migration 20261017020000.';
COMMENT ON COLUMN public.clients.vet_treatment_limit_cents IS
  'What a sitter may spend on vet treatment without asking. NULL is not set. Migration 20261017020000.';
COMMENT ON COLUMN public.dogs.vet_clinic_name IS
  'The pet''s vet clinic, for the sitter. Migration 20261017020000.';

CREATE OR REPLACE FUNCTION public.stay_contact_gaps(_stay_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT array_remove(ARRAY[
           CASE WHEN NULLIF(btrim(c.emergency_contact_name), '') IS NULL
                  OR NULLIF(btrim(c.emergency_contact_phone), '') IS NULL
                THEN 'emergency_contact' END,
           CASE WHEN EXISTS (
                  SELECT 1 FROM public.dogs d
                   WHERE d.id = ANY(st.pet_ids)
                     AND (NULLIF(btrim(d.vet_clinic_name), '') IS NULL
                          OR NULLIF(btrim(d.vet_clinic_phone), '') IS NULL))
                THEN 'vet' END,
           CASE WHEN c.vet_treatment_limit_cents IS NULL THEN 'treatment_limit' END
         ], NULL)
    FROM public.stays st
    JOIN public.clients c ON c.id = st.client_id
   WHERE st.id = _stay_id
     AND public.can_write_org((SELECT auth.uid()), st.organization_id);
$function$;

REVOKE ALL ON FUNCTION public.stay_contact_gaps(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stay_contact_gaps(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.stay_contact_gaps(uuid) IS
  'What a stay is missing for an emergency: emergency_contact, vet, treatment_limit. Empty when nothing is missing, NULL when the caller is not the office. Warns, never refuses. Migration 20261017020000.';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
DECLARE
  _col text;
BEGIN
  FOREACH _col IN ARRAY ARRAY['emergency_contact_name', 'emergency_contact_phone',
                              'emergency_contact_may_approve_vet', 'vet_treatment_limit_cents'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = _col) THEN
      RAISE EXCEPTION 'clients.% is missing', _col;
    END IF;
  END LOOP;
  FOREACH _col IN ARRAY ARRAY['vet_clinic_name', 'vet_clinic_phone'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'dogs' AND column_name = _col) THEN
      RAISE EXCEPTION 'dogs.% is missing', _col;
    END IF;
  END LOOP;
  IF to_regprocedure('public.stay_contact_gaps(uuid)') IS NULL
     OR has_function_privilege('anon', 'public.stay_contact_gaps(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.stay_contact_gaps(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'stay_contact_gaps is missing or has the wrong grants';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.clients', 'emergency_contact_phone', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.dogs', 'vet_clinic_phone', 'SELECT') THEN
    RAISE EXCEPTION 'signed-in users cannot read the emergency columns';
  END IF;
END
$check$;
