-- Client-level DNA compliance opt-in (IA rework): the /dna workspace starts
-- from the commercial/HOA clients that have toggled DNA compliance on, then
-- drills into their samples, matches, and registered dogs. Residential
-- clients never carry the flag; nothing else about the units/dogs/dna data
-- flows changes (I3).

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS dna_compliance_enabled boolean NOT NULL DEFAULT false;

-- The /dna landing list scans "enabled clients per org" — a partial index
-- keeps that lookup cheap without indexing the (majority) disabled rows.
CREATE INDEX IF NOT EXISTS clients_dna_compliance_idx
  ON public.clients (organization_id)
  WHERE dna_compliance_enabled;

-- ── Idempotent backfill ──────────────────────────────────────────────────────
-- Enable the flag for COMMERCIAL clients that already have DNA activity, so
-- existing workspaces don't land on an empty list after the IA rework:
--   * any dna_matches row keyed to the client (directly, or via one of the
--     client's properties — older samples may carry only property_id), OR
--   * any dog of theirs with DNA registration activity. Dogs link to a client
--     via properties.client_id; "activity" is dogs.dna_registered = true
--     (20260702163752) or dogs.dna_status <> 'not_registered'
--     (20260716230000: 'not_registered' | 'pending' | 'registered').
-- Only flips false→true, so re-running (or a later manual disable) is safe.
UPDATE public.clients c
   SET dna_compliance_enabled = true
 WHERE c.account_type = 'commercial'
   AND c.dna_compliance_enabled IS DISTINCT FROM true
   AND (
     EXISTS (
       SELECT 1 FROM public.dna_matches m
        WHERE m.client_id = c.id
     )
     OR EXISTS (
       SELECT 1
         FROM public.dna_matches m
         JOIN public.properties p ON p.id = m.property_id
        WHERE p.client_id = c.id
     )
     OR EXISTS (
       SELECT 1
         FROM public.dogs d
         JOIN public.properties p ON p.id = d.property_id
        WHERE p.client_id = c.id
          AND (d.dna_registered = true OR d.dna_status <> 'not_registered')
     )
   );
