-- A converted lead kept only its name.
--
-- Found 2026-09-27 by a tester playing an owner switching from Jobber: lead
-- "Lauren Woods" (ZIP 10001, three dogs, weekly) converted into a client with
-- no property, no dogs, no service and a status of Inactive. The app side of
-- the fix is in src/lib/lead-conversion.ts: conversion now opens the new-client
-- wizard started from the lead, and the lead is marked converted when that
-- wizard saves.
--
-- This file is the half the app cannot do alone. A conversion used to record
-- only `status = 'converted'` and `converted_at`. Nothing said WHICH client a
-- lead became, so the leads page could not offer "Open client", and the only
-- thing stopping a second conversion of the same person was a status the
-- status menu lets anyone change back.
--
-- ── WHAT THIS ESTABLISHES ─────────────────────────────────────────────────
--
--   1. leads.converted_client_id, a foreign key to clients, ON DELETE SET NULL.
--      Deleting a client (deleteClientIfNoHistory allows it for a client with
--      no visits, invoices or services) leaves the lead converted and unlinked
--      rather than blocking the delete or deleting the lead with it.
--   2. An index on it. The SET NULL above looks leads up by this column every
--      time a client is deleted; 20260809210000 is the file that went round
--      closing ninety-three unindexed foreign keys, and this is not going to
--      be the ninety-fourth.
--   3. The public INSERT policy refuses a submission that arrives already
--      linked to a client, alongside the status / contacted_at / converted_at
--      it already refuses. Same reason as those three: that column is the
--      tenant's own workflow state, and a form submission is always a new,
--      untouched lead. The policy is otherwise 20260804030000's, unchanged.
--   4. A backfill for leads converted before the link existed, using the old
--      conversion's own matching rule: the client in the same organization
--      whose primary_email is the lead's email, lower-cased. convertLeadToClient
--      reused exactly that client when one existed and created one with exactly
--      that email when not, so for a lead it converted, the match is the client
--      it produced. The earliest wins where two match. A lead marked converted
--      by hand from the status menu matches nothing and stays unlinked, which
--      the app shows as converted with neither action on offer.
--
-- The backfill's row count is a fact about the database it runs on, not about
-- this change, so it is printed and not asserted. On a fresh replay it is zero.
--
-- Replays into an empty database: adds a column, an index and a policy, and
-- updates rows only where they exist. Asserts only what it creates.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS converted_client_id uuid
    REFERENCES public.clients(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.leads.converted_client_id IS
  'The client this lead became. Set when the new-client wizard, opened from this lead, saves. NULL on a lead that is not converted, or that was marked converted by hand, or whose client was later deleted.';

CREATE INDEX IF NOT EXISTS leads_converted_client_id_idx
  ON public.leads (converted_client_id);

DROP POLICY IF EXISTS "Anyone can submit a lead to a business that publishes a form" ON public.leads;

CREATE POLICY "Anyone can submit a lead to a business that publishes a form"
  ON public.leads
  FOR INSERT
  WITH CHECK (
    organization_id IS NOT NULL
    AND public.org_accepts_public_leads(organization_id)
    -- A submission is always a new, untouched lead. Anything else is the
    -- submitter writing into the tenant's own workflow state.
    AND status = 'new'
    AND contacted_at IS NULL
    AND converted_at IS NULL
    AND converted_client_id IS NULL
  );

COMMENT ON POLICY "Anyone can submit a lead to a business that publishes a form" ON public.leads IS
  'Replaces WITH CHECK (true), which let any holder of the publishable key write a lead into any organization_id — or into none at all, creating rows no tenant could see or delete. Since 20260928090000 also refuses a lead that arrives already linked to a client.';

-- Tagged $link$ rather than the more obvious backfill tag, because
-- tests/thirty-meant-both-a-speed-and-a-silence finds its own migration's
-- block as the LAST block with that tag anywhere in this directory.
DO $link$
DECLARE
  _linked int;
BEGIN
  -- Only leads that HAVE a match are touched, so an unmatched one keeps its
  -- updated_at rather than being rewritten to the NULL it already holds.
  UPDATE public.leads l
     SET converted_client_id = m.client_id
    FROM (
      SELECT DISTINCT ON (l2.id) l2.id AS lead_id, c.id AS client_id
        FROM public.leads l2
        JOIN public.clients c
          ON c.organization_id = l2.organization_id
         AND c.primary_email = lower(l2.email)
       WHERE l2.status = 'converted'
         AND l2.converted_client_id IS NULL
       ORDER BY l2.id, c.created_at, c.id
    ) m
   WHERE l.id = m.lead_id;
  GET DIAGNOSTICS _linked = ROW_COUNT;
  RAISE NOTICE 'converted leads linked to their client by the backfill: %', _linked;
END
$link$;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.leads'::regclass
       AND contype = 'f'
       AND confrelid = 'public.clients'::regclass
       AND confdeltype = 'n'
       AND conkey = ARRAY[(
             SELECT attnum FROM pg_attribute
              WHERE attrelid = 'public.leads'::regclass
                AND attname = 'converted_client_id'
           )]::int2[]
  ) THEN
    RAISE EXCEPTION 'leads.converted_client_id is not a foreign key to clients with ON DELETE SET NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = 'public.leads'::regclass
       AND a.attname = 'converted_client_id'
       AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'leads.converted_client_id has no valid index leading on it';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'leads'
       AND cmd = 'INSERT'
       AND policyname = 'Anyone can submit a lead to a business that publishes a form'
       AND with_check ILIKE '%converted_client_id IS NULL%'
  ) THEN
    RAISE EXCEPTION 'the public lead INSERT policy does not refuse a pre-linked lead';
  END IF;
END
$post$;
