-- An import is undone whole or not at all (#857): what 20261111050000's
-- undo_import_batch does, proved against a real Postgres. Run by
-- tests/an-import-is-undone-whole-or-not-at-all.test.ts, which passes
-- :migration, the file under proof. Every earlier migration is assumed
-- applied (a local stack built from main).
--
-- The first undo ran eight deletes from the server as the caller: a user who
-- could import but not bill deleted the dogs, plans and properties, the
-- invoices silently survived under RLS, the client delete then failed on
-- invoices.client_id's RESTRICT, and the batch said it was never undone
-- (review of #879). Here: a committed batch that made a client with an
-- address, a pet, a paused plan, an opening balance and a note; a caller
-- without the import permission is refused; a batch with a visit on it is
-- refused; a delete that fails partway (a trigger that refuses the pet's
-- delete) leaves every record and the batch exactly as they were; and the
-- owner's undo removes all of it, releases the file's claim, keeps the rows,
-- and cannot run twice.
--
-- One transaction, ROLLED BACK at the end, migration included. Each group
-- prints "ok: ..." only when every check in it passed, or raises
-- "PROOF FAILED [...]"; ON_ERROR_STOP makes the first failure the exit code.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- ── A tenant, an owner, a dispatcher, and one committed import ─────────────

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a8570000-0000-4000-8000-000000000001', 'owner@undo.proof.invalid'),
  ('a8570000-0000-4000-8000-000000000002', 'dispatch@undo.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a857000-0000-4000-8000-000000000000', 'Undo Proof A', 'America/Detroit');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a8570000-0000-4000-8000-000000000001', '0a857000-0000-4000-8000-000000000000', 'owner'),
  ('a8570000-0000-4000-8000-000000000002', '0a857000-0000-4000-8000-000000000000', 'dispatcher');
SET LOCAL app.allow_protected_org_write = '';

-- ── The migration, twice: it has to be safe to run again ────────────────────

\i :migration
\i :migration

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'undo_import_batch') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [twice]: expected exactly one undo_import_batch';
  END IF;
  IF has_function_privilege('anon', 'public.undo_import_batch(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [twice]: anon can call undo_import_batch';
  END IF;
  RAISE NOTICE 'ok: the migration applies twice and leaves one undo function anon cannot call';
END $$;

-- What a committed Jobber clients file leaves behind: one client with an
-- address, a pet, a paused plan, an opening balance and an office note; a
-- batch that claimed the file; a row pointing at the client; and a client
-- the business already had, which the undo must not touch.
INSERT INTO public.import_batches (id, organization_id, created_by, source, entity, status, committed_at,
                                   commit_started_at, content_hash, mapping, stats)
VALUES ('b8570000-0000-4000-8000-000000000001', '0a857000-0000-4000-8000-000000000000',
        'a8570000-0000-4000-8000-000000000001', 'jobber', 'clients', 'committed', now() - interval '1 hour',
        now() - interval '1 hour', 'proof-hash-857', '{}'::jsonb, '{"total":1,"created":1}'::jsonb);
INSERT INTO public.clients (id, organization_id, account_type, display_name, import_source, import_batch_id, comms_paused) VALUES
  ('c8570000-0000-4000-8000-000000000001', '0a857000-0000-4000-8000-000000000000', 'residential', 'Imported Person',
   'jobber', 'b8570000-0000-4000-8000-000000000001', true),
  ('c8570000-0000-4000-8000-000000000009', '0a857000-0000-4000-8000-000000000000', 'residential', 'Existing Person',
   NULL, NULL, false);
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('d8570000-0000-4000-8000-000000000001', '0a857000-0000-4000-8000-000000000000',
   'c8570000-0000-4000-8000-000000000001', '12 Example Lane', 'Royal Oak', '48073'),
  ('d8570000-0000-4000-8000-000000000009', '0a857000-0000-4000-8000-000000000000',
   'c8570000-0000-4000-8000-000000000009', '9 Kept St', 'Royal Oak', '48073');
INSERT INTO public.dogs (id, organization_id, property_id, name) VALUES
  ('f8570000-0000-4000-8000-000000000001', '0a857000-0000-4000-8000-000000000000',
   'd8570000-0000-4000-8000-000000000001', 'Biscuit');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, status, paused_at)
VALUES ('e8570000-0000-4000-8000-000000000001', '0a857000-0000-4000-8000-000000000000',
        'c8570000-0000-4000-8000-000000000001', 'd8570000-0000-4000-8000-000000000001', 'residential',
        'weekly', 1800, 1, current_date, 'paused', now());
INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status, issued_at, notes) VALUES
  ('18570000-0000-4000-8000-000000000001', '0a857000-0000-4000-8000-000000000000',
   'c8570000-0000-4000-8000-000000000001', current_date, 4500, 'open', now(), 'Opening balance');
INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents) VALUES
  ('18570000-0000-4000-8000-000000000001', 'Opening balance carried over from Jobber', 4500);
INSERT INTO public.client_notes (organization_id, client_id, property_id, audience, body) VALUES
  ('0a857000-0000-4000-8000-000000000000', 'c8570000-0000-4000-8000-000000000001',
   'd8570000-0000-4000-8000-000000000001', 'office', 'Imported from Jobber. Lead Source: Google.');
INSERT INTO public.import_rows (batch_id, organization_id, row_num, raw, mapped, action, target_id) VALUES
  ('b8570000-0000-4000-8000-000000000001', '0a857000-0000-4000-8000-000000000000', 1,
   '{"Client Full Name (Display Only)":"Imported Person"}'::jsonb, '{"display_name":"Imported Person"}'::jsonb,
   'create', 'c8570000-0000-4000-8000-000000000001');

-- Everything the undo must leave alone or put back, counted before.
CREATE TEMP TABLE proof_counts AS
  SELECT (SELECT count(*) FROM public.clients WHERE organization_id = '0a857000-0000-4000-8000-000000000000') AS clients,
         (SELECT count(*) FROM public.properties WHERE organization_id = '0a857000-0000-4000-8000-000000000000') AS properties,
         (SELECT count(*) FROM public.dogs WHERE organization_id = '0a857000-0000-4000-8000-000000000000') AS dogs,
         (SELECT count(*) FROM public.subscriptions WHERE organization_id = '0a857000-0000-4000-8000-000000000000') AS plans,
         (SELECT count(*) FROM public.invoices WHERE organization_id = '0a857000-0000-4000-8000-000000000000') AS invoices,
         (SELECT count(*) FROM public.invoice_line_items WHERE invoice_id = '18570000-0000-4000-8000-000000000001') AS lines,
         (SELECT count(*) FROM public.client_notes WHERE organization_id = '0a857000-0000-4000-8000-000000000000') AS notes,
         (SELECT count(*) FROM public.import_rows WHERE batch_id = 'b8570000-0000-4000-8000-000000000001') AS rows;

CREATE FUNCTION public.proof_857_nothing_changed(_where text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE _c proof_counts%ROWTYPE; _b public.import_batches%ROWTYPE;
BEGIN
  SELECT * INTO _c FROM proof_counts;
  IF (SELECT count(*) FROM public.clients WHERE organization_id = '0a857000-0000-4000-8000-000000000000') <> _c.clients
     OR (SELECT count(*) FROM public.properties WHERE organization_id = '0a857000-0000-4000-8000-000000000000') <> _c.properties
     OR (SELECT count(*) FROM public.dogs WHERE organization_id = '0a857000-0000-4000-8000-000000000000') <> _c.dogs
     OR (SELECT count(*) FROM public.subscriptions WHERE organization_id = '0a857000-0000-4000-8000-000000000000') <> _c.plans
     OR (SELECT count(*) FROM public.invoices WHERE organization_id = '0a857000-0000-4000-8000-000000000000') <> _c.invoices
     OR (SELECT count(*) FROM public.invoice_line_items WHERE invoice_id = '18570000-0000-4000-8000-000000000001') <> _c.lines
     OR (SELECT count(*) FROM public.client_notes WHERE organization_id = '0a857000-0000-4000-8000-000000000000') <> _c.notes THEN
    RAISE EXCEPTION 'PROOF FAILED [%]: a refused undo deleted something', _where;
  END IF;
  SELECT * INTO _b FROM public.import_batches WHERE id = 'b8570000-0000-4000-8000-000000000001';
  IF _b.undone_at IS NOT NULL OR _b.commit_started_at IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [%]: a refused undo marked the batch undone or released its claim', _where;
  END IF;
END $fn$;

-- ── A dispatcher cannot undo an import ──────────────────────────────────────

SELECT set_config('request.jwt.claims', '{"sub":"a8570000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.undo_import_batch('b8570000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'PROOF FAILED [dispatcher]: a dispatcher undid an import';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err LIKE 'PROOF FAILED%' THEN RAISE; END IF;
    IF _err <> 'Not authorized' THEN
      RAISE EXCEPTION 'PROOF FAILED [dispatcher]: refused, but said "%"', _err;
    END IF;
  END;
END $$;
RESET ROLE;
SELECT public.proof_857_nothing_changed('dispatcher');
DO $$ BEGIN RAISE NOTICE 'ok: a dispatcher is refused and nothing is deleted'; END $$;

-- ── A batch with a visit on it is refused whole ─────────────────────────────

INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, status)
VALUES ('78570000-0000-4000-8000-000000000001', '0a857000-0000-4000-8000-000000000000',
        'e8570000-0000-4000-8000-000000000001', 'c8570000-0000-4000-8000-000000000001',
        'd8570000-0000-4000-8000-000000000001', current_date + 1, 'scheduled');
SELECT set_config('request.jwt.claims', '{"sub":"a8570000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.undo_import_batch('b8570000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'PROOF FAILED [in use]: a batch with a visit was undone';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err LIKE 'PROOF FAILED%' THEN RAISE; END IF;
    IF _err NOT LIKE 'This import is in use: 1 visit.%' THEN
      RAISE EXCEPTION 'PROOF FAILED [in use]: refused, but said "%"', _err;
    END IF;
  END;
END $$;
RESET ROLE;
SELECT public.proof_857_nothing_changed('in use');
DELETE FROM public.visits WHERE id = '78570000-0000-4000-8000-000000000001';
DO $$ BEGIN RAISE NOTICE 'ok: a batch with a visit on it is refused and nothing is deleted'; END $$;

-- ── A delete that fails partway puts everything back ───────────────────────
--
-- The pet's delete is refused by a trigger, as a policy, a lock or a full
-- disk might refuse any one of the eight. The undo had already claimed the
-- batch and deleted nothing before the pet; afterwards the client, address,
-- plan, balance and note are all still there and the batch is not undone.

CREATE FUNCTION public.proof_857_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'PROOF: the pet could not be deleted'; END $fn$;
CREATE TRIGGER proof_refuse_dog_delete BEFORE DELETE ON public.dogs
  FOR EACH ROW EXECUTE FUNCTION public.proof_857_refuse_delete();

SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.undo_import_batch('b8570000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'PROOF FAILED [midway]: the undo finished past a delete that failed';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err LIKE 'PROOF FAILED%' THEN RAISE; END IF;
    IF _err <> 'PROOF: the pet could not be deleted' THEN
      RAISE EXCEPTION 'PROOF FAILED [midway]: stopped, but said "%"', _err;
    END IF;
  END;
END $$;
RESET ROLE;
DROP TRIGGER proof_refuse_dog_delete ON public.dogs;
SELECT public.proof_857_nothing_changed('midway');
DO $$ BEGIN RAISE NOTICE 'ok: a delete that fails partway leaves every record and the batch as they were'; END $$;

-- ── The owner undoes it: everything the batch made is gone, nothing else ───

SET ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  _r := public.undo_import_batch('b8570000-0000-4000-8000-000000000001');
  IF (_r ->> 'undone')::int <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [whole]: the undo reported % undone', _r ->> 'undone';
  END IF;
END $$;
RESET ROLE;
DO $$
DECLARE _b public.import_batches%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM public.clients WHERE id = 'c8570000-0000-4000-8000-000000000001')
     OR EXISTS (SELECT 1 FROM public.properties WHERE id = 'd8570000-0000-4000-8000-000000000001')
     OR EXISTS (SELECT 1 FROM public.dogs WHERE id = 'f8570000-0000-4000-8000-000000000001')
     OR EXISTS (SELECT 1 FROM public.subscriptions WHERE id = 'e8570000-0000-4000-8000-000000000001')
     OR EXISTS (SELECT 1 FROM public.invoices WHERE id = '18570000-0000-4000-8000-000000000001')
     OR EXISTS (SELECT 1 FROM public.invoice_line_items WHERE invoice_id = '18570000-0000-4000-8000-000000000001')
     OR EXISTS (SELECT 1 FROM public.client_notes WHERE client_id = 'c8570000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'PROOF FAILED [whole]: something the batch made is still there';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = 'c8570000-0000-4000-8000-000000000009')
     OR NOT EXISTS (SELECT 1 FROM public.properties WHERE id = 'd8570000-0000-4000-8000-000000000009') THEN
    RAISE EXCEPTION 'PROOF FAILED [whole]: a client the business already had was deleted';
  END IF;
  SELECT * INTO _b FROM public.import_batches WHERE id = 'b8570000-0000-4000-8000-000000000001';
  IF _b.undone_at IS NULL OR _b.commit_started_at IS NOT NULL OR _b.status <> 'committed'
     OR (_b.stats ->> 'undone')::int <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [whole]: the batch does not read undone with its claim released';
  END IF;
  IF (SELECT count(*) FROM public.import_rows WHERE batch_id = 'b8570000-0000-4000-8000-000000000001')
     <> (SELECT rows FROM proof_counts) THEN
    RAISE EXCEPTION 'PROOF FAILED [whole]: the batch''s rows were deleted; the page could no longer say what it did';
  END IF;
  RAISE NOTICE 'ok: the owner''s undo removes everything the batch made, nothing else, and keeps the rows';
END $$;

-- ── Twice: refused, and the file can be imported again ─────────────────────

SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.undo_import_batch('b8570000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'PROOF FAILED [twice-undo]: an undone batch was undone again';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err LIKE 'PROOF FAILED%' THEN RAISE; END IF;
    IF _err <> 'This import has already been undone.' THEN
      RAISE EXCEPTION 'PROOF FAILED [twice-undo]: refused, but said "%"', _err;
    END IF;
  END;
END $$;
RESET ROLE;
-- The one-commit-per-file index (20261015090000) no longer holds the hash:
-- a new batch of the same file can claim it.
INSERT INTO public.import_batches (id, organization_id, created_by, source, entity, status, commit_started_at, content_hash)
VALUES ('b8570000-0000-4000-8000-000000000002', '0a857000-0000-4000-8000-000000000000',
        'a8570000-0000-4000-8000-000000000001', 'jobber', 'clients', 'previewing', now(), 'proof-hash-857');
DO $$ BEGIN RAISE NOTICE 'ok: a second undo is refused and the same file can be imported again'; END $$;

DO $$ BEGIN RAISE NOTICE 'ALL IMPORT-UNDO PROOFS PASSED'; END $$;

ROLLBACK;
