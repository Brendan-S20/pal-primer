-- A tech could rewrite any DNA violation in their organization.
--
-- ── WHAT WAS OPEN ──────────────────────────────────────────────────────────
--
-- Every RLS policy on public.dna_matches was `is_org_member(auth.uid(),
-- organization_id)` — read, insert, update AND delete. `is_org_member` includes
-- techs, and a tech holds neither `can_write_org` nor `manage_dna_billing`, and
-- cannot even open /dna (ROUTE_ROLES is owner/office_manager/dispatcher).
--
-- Two BEFORE triggers were doing the real authorization, and they cover the
-- money precisely: `tg_dna_matches_guard_billing` refuses a change to
-- `fine_cents` or a move to status 'billed' without `manage_dna_billing`, and
-- `tg_dna_matches_guard_delete` refuses deleting a sample that is past
-- 'new'/'sent_to_lab'. Both are good guards. Neither covers WHO a violation
-- blames or WHETHER IT IS STILL OPEN.
--
-- Proven against the live database as a real tech user, in a transaction that
-- rolled itself back:
--
--   repointed_to_other_dog = 1   -- moved a $250 violation onto another
--                                -- client's dog; fine_cents never changed, so
--                                -- the billing guard never fired
--   closed_violation       = 1   -- status 'matched' → 'closed'; not 'billed',
--                                -- so the billing guard never fired
--   deleted_sample_at_lab  = 1   -- destroyed a 'sent_to_lab' sample, which the
--                                -- delete guard deliberately allows
--
-- The shape matters more than the instance: the guards were written around the
-- *money column*, and everything that determines who pays — the attribution and
-- the lifecycle — sat outside them. It is the same lesson as BUG-33 and BUG-36,
-- where a server function was the only real gate and the table was open to
-- anyone who went around it. A tech is also the one party with a motive here:
-- a DNA violation can be evidence about a property they service.
--
-- ── EXPOSURE ───────────────────────────────────────────────────────────────
--
-- Latent. `dna_matches` holds zero rows — no tenant has used DNA compliance
-- yet. Nothing has been tampered with. Stated plainly rather than dressed up.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
--
-- Move the baseline from "any member of the org" to "someone who can write for
-- the org" — `can_write_org` is owner/office_manager/dispatcher, exactly the
-- audience ROUTE_ROLES already grants /dna. The two triggers stay, so
-- `manage_dna_billing` still gates fines, billing and processed deletes on top.
-- Layered, not replaced.
--
-- SELECT is tightened with the rest, deliberately: the DNA workspace is
-- documented as office/dispatch only (H1/I7), the read server functions already
-- reject techs, and nothing tech-facing reads this table — the my-day surface
-- has no DNA affordance of any kind. Leaving reads open would keep a
-- cross-client registry of clients, dogs and fines legible to every field tech.
--
-- If tech-side sample logging is built later (the useMyRole comment claims it
-- exists; it does not — see Q-5), it needs its own narrow INSERT policy scoped
-- to the tech's assigned visits, not a return to org-wide write.

DROP POLICY IF EXISTS "org members read dna_matches" ON public.dna_matches;
DROP POLICY IF EXISTS "org staff insert dna_matches" ON public.dna_matches;
DROP POLICY IF EXISTS "org staff update dna_matches" ON public.dna_matches;
DROP POLICY IF EXISTS "org staff delete dna_matches" ON public.dna_matches;

CREATE POLICY "office reads dna_matches" ON public.dna_matches
  FOR SELECT TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id));

CREATE POLICY "office inserts dna_matches" ON public.dna_matches
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE POLICY "office updates dna_matches" ON public.dna_matches
  FOR UPDATE TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE POLICY "office deletes dna_matches" ON public.dna_matches
  FOR DELETE TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id));

DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'dna_matches';
  IF _n <> 4 THEN
    RAISE EXCEPTION 'expected exactly 4 policies on dna_matches, found %', _n;
  END IF;
  -- The triggers are the second layer and must survive this migration.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.dna_matches'::regclass
                   AND tgname='dna_matches_guard_billing') THEN
    RAISE EXCEPTION 'the billing guard trigger is gone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.dna_matches'::regclass
                   AND tgname='dna_matches_guard_delete') THEN
    RAISE EXCEPTION 'the delete guard trigger is gone';
  END IF;
END $$;
