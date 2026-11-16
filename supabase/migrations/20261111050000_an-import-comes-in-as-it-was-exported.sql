-- An import comes in as it was exported (#857).
--
-- A business moving to HoundStack brings the file its old software wrote,
-- and until now every column the mapping did not name was discarded without
-- a word: Jobber's Account Balance, Lead Source and Archived flag, Gingr's
-- Referral, a custom field a business had typed into for years. The owner's
-- direction (Nov 10 2026): "each field serves a purpose and as much data
-- comes through and smoothly over". Product's default for a column with no
-- field: keep it as structured raw JSON on the client, with a short summary
-- in the client's notes, and show it on the review screen. Nothing dropped
-- silently.
--
-- Four things this file establishes, nothing it reads:
--
--   import_source gains 'gingr' and 'moego'. Both are recognized by best
--   guess only (no sample export is in hand) and every column of such a
--   file is shown before anything is saved; the value is so the batch and
--   the clients it makes can say where they came from.
--
--   clients.import_extras holds the leftover columns of the row that made
--   the client, as the file spelled them ({"Lead Source": "Referral", ...}).
--   NULL for a client not imported, or imported from a file with nothing
--   left over. It is the raw record; the summary in notes is for a person.
--
--   import_batches.undone_at is set by undo_import_batch once everything a
--   committed batch created has been deleted. An undone batch keeps its rows
--   and its hash; its commit claim is released, so the same file can be
--   imported again, and it is left out of the "this file was already
--   imported" check.
--
--   undo_import_batch(uuid) is the undo itself, in ONE transaction. The first
--   version ran eight separate deletes from the server as the caller: a user
--   who could import but not bill deleted the dogs, plans and properties,
--   the invoices silently survived under RLS (0 rows, no error), the client
--   delete then failed on invoices.client_id's RESTRICT, and the batch said
--   it was never undone (review of #879). Here every guard runs first (the
--   caller's permissions, nothing used since, nothing updated rather than
--   created), every delete's row count is checked against what was counted a
--   moment before, and any mismatch or error rolls the whole thing back.
--   Nothing is half undone.
--
-- ALTER TYPE ... ADD VALUE is allowed inside a transaction; the new value
-- only cannot be USED in the same transaction, and nothing here uses it.
-- Replays into an empty database: every statement is IF NOT EXISTS or
-- CREATE OR REPLACE.

ALTER TYPE public.import_source ADD VALUE IF NOT EXISTS 'gingr';
ALTER TYPE public.import_source ADD VALUE IF NOT EXISTS 'moego';

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS import_extras jsonb;

COMMENT ON COLUMN public.clients.import_extras IS
  'Columns of the imported row that no field consumed, as the file spelled them '
  '({"Lead Source": "Referral"}). Written once by commitImport; the summary a '
  'person reads is at the end of notes. NULL when nothing was left over.';

ALTER TABLE public.import_batches
  ADD COLUMN IF NOT EXISTS undone_at timestamptz;

COMMENT ON COLUMN public.import_batches.undone_at IS
  'When undo_import_batch deleted everything this committed batch created. The '
  'batch keeps its rows and content_hash and no longer counts as having imported the file.';

-- ── The undo, whole or not at all ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.undo_import_batch(_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _b public.import_batches%ROWTYPE;
  _uid uuid := auth.uid();
  _entity text;
  _ids uuid[];
  _prop_ids uuid[] := '{}';
  _inv_ids uuid[] := '{}';
  _updated integer;
  _visits integer := 0;
  _payments integer := 0;
  _later integer := 0;
  _writes_invoices boolean := false;
  _expected integer;
  _got integer;
  _removed integer := 0;
BEGIN
  -- One undo at a time per batch: a second tap waits for the first, then
  -- reads undone_at set and is told so.
  SELECT * INTO _b FROM public.import_batches WHERE id = _batch_id FOR UPDATE;
  IF _b.id IS NULL THEN
    RAISE EXCEPTION 'This import no longer exists. It may have been removed.';
  END IF;
  -- The same gate the whole import surface has (20261029090000).
  IF _uid IS NULL OR NOT public.has_permission(_uid, _b.organization_id, 'manage_imports') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _b.undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'This import has already been undone.';
  END IF;
  IF _b.committed_at IS NULL OR _b.status NOT IN ('committed', 'failed') THEN
    RAISE EXCEPTION 'Only an import that has been committed can be undone.';
  END IF;
  _entity := COALESCE(_b.entity, 'clients');

  -- A batch that changed clients the business already had cannot be put
  -- back: their earlier values were not kept.
  SELECT count(*) INTO _updated
    FROM public.import_rows
   WHERE batch_id = _batch_id AND action = 'update';
  IF _updated > 0 THEN
    RAISE EXCEPTION 'This import changed % client% you already had, and their earlier values were not kept, so it cannot be undone. Edit those clients by hand instead.',
      _updated, CASE WHEN _updated = 1 THEN '' ELSE 's' END;
  END IF;

  -- What the batch created: its rows' targets, and for a clients file every
  -- client that carries the batch's id (a row whose target could not be
  -- recorded still made its client, #617). Only this business's records.
  SELECT COALESCE(array_agg(DISTINCT target_id), '{}') INTO _ids
    FROM public.import_rows
   WHERE batch_id = _batch_id AND action = 'create' AND target_id IS NOT NULL;
  IF _entity = 'clients' THEN
    SELECT COALESCE(array_agg(DISTINCT id), '{}') INTO _ids
      FROM public.clients
     WHERE organization_id = _b.organization_id
       AND (id = ANY(_ids) OR import_batch_id = _batch_id);
  ELSIF _entity = 'properties' THEN
    SELECT COALESCE(array_agg(id), '{}') INTO _ids FROM public.properties
     WHERE organization_id = _b.organization_id AND id = ANY(_ids);
  ELSIF _entity = 'dogs' THEN
    SELECT COALESCE(array_agg(id), '{}') INTO _ids FROM public.dogs
     WHERE organization_id = _b.organization_id AND id = ANY(_ids);
  ELSIF _entity = 'services' THEN
    SELECT COALESCE(array_agg(id), '{}') INTO _ids FROM public.subscriptions
     WHERE organization_id = _b.organization_id AND id = ANY(_ids);
  ELSIF _entity = 'balances' THEN
    SELECT COALESCE(array_agg(id), '{}') INTO _ids FROM public.invoices
     WHERE organization_id = _b.organization_id AND id = ANY(_ids);
  ELSE
    RAISE EXCEPTION 'Unknown import entity %', _entity;
  END IF;

  -- Nothing from the batch may have been used since (the product rule,
  -- Nov 10 2026): visits on its clients, properties or plans; payments on
  -- its invoices or its clients' invoices; invoices written on its clients
  -- that it did not write itself.
  IF _entity = 'clients' THEN
    SELECT count(*) INTO _visits FROM public.visits WHERE client_id = ANY(_ids);
    SELECT COALESCE(array_agg(id), '{}') INTO _inv_ids FROM public.invoices WHERE client_id = ANY(_ids);
    SELECT count(*) INTO _later FROM public.invoices
     WHERE id = ANY(_inv_ids) AND COALESCE(notes, '') NOT LIKE 'Opening balance%';
    SELECT count(*) INTO _payments FROM public.payments WHERE invoice_id = ANY(_inv_ids);
    SELECT COALESCE(array_agg(id), '{}') INTO _prop_ids FROM public.properties WHERE client_id = ANY(_ids);
    _writes_invoices := cardinality(_inv_ids) > 0;
  ELSIF _entity = 'properties' THEN
    SELECT count(*) INTO _visits FROM public.visits WHERE property_id = ANY(_ids);
    _prop_ids := _ids;
  ELSIF _entity = 'services' THEN
    SELECT count(*) INTO _visits FROM public.visits WHERE subscription_id = ANY(_ids);
  ELSIF _entity = 'balances' THEN
    SELECT count(*) INTO _payments FROM public.payments WHERE invoice_id = ANY(_ids);
    SELECT _payments + count(*) INTO _payments FROM public.invoices WHERE id = ANY(_ids) AND status <> 'open';
    _inv_ids := _ids;
    _writes_invoices := true;
  END IF;
  IF _visits > 0 OR _payments > 0 OR _later > 0 THEN
    RAISE EXCEPTION 'This import is in use: %. Undo is only possible before anything from the import has visits or payments. Archive or edit the records by hand instead.',
      concat_ws(', ',
        CASE WHEN _visits > 0 THEN _visits || ' visit' || CASE WHEN _visits = 1 THEN '' ELSE 's' END END,
        CASE WHEN _payments > 0 THEN _payments || ' payment' || CASE WHEN _payments = 1 THEN '' ELSE 's' END END,
        CASE WHEN _later > 0 THEN _later || ' invoice' || CASE WHEN _later = 1 THEN '' ELSE 's' END || ' written since' END);
  END IF;

  -- Deleting an invoice is a billing act, the permission the commit asked
  -- for to write it. Asked BEFORE anything is deleted, so a caller without
  -- it is refused whole rather than left with half a client.
  IF _writes_invoices AND NOT public.has_permission(_uid, _b.organization_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Undoing this import deletes the opening balances it wrote, which needs the billing permission. Ask an owner to undo it.';
  END IF;

  -- Claim first. Any RAISE below rolls this back with the deletes.
  UPDATE public.import_batches
     SET undone_at = now(), commit_started_at = NULL
   WHERE id = _batch_id AND undone_at IS NULL;
  GET DIAGNOSTICS _got = ROW_COUNT;
  IF _got <> 1 THEN
    RAISE EXCEPTION 'This import has already been undone.';
  END IF;

  -- Every delete is counted before and after. A count that does not match
  -- (a row this function cannot see, a policy, a trigger that refused)
  -- stops the undo, and the transaction puts everything back.
  IF _entity IN ('clients', 'properties') THEN
    SELECT count(*) INTO _expected FROM public.dogs WHERE property_id = ANY(_prop_ids);
    DELETE FROM public.dogs WHERE property_id = ANY(_prop_ids);
    GET DIAGNOSTICS _got = ROW_COUNT;
    IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped: expected to remove % pet(s), removed %. Nothing was changed.', _expected, _got; END IF;
    _removed := _removed + _got;

    SELECT count(*) INTO _expected FROM public.waste_stations WHERE property_id = ANY(_prop_ids);
    DELETE FROM public.waste_stations WHERE property_id = ANY(_prop_ids);
    GET DIAGNOSTICS _got = ROW_COUNT;
    IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped: expected to remove % station(s), removed %. Nothing was changed.', _expected, _got; END IF;
  END IF;

  IF _entity = 'clients' THEN
    SELECT count(*) INTO _expected FROM public.subscriptions WHERE client_id = ANY(_ids);
    DELETE FROM public.subscriptions WHERE client_id = ANY(_ids);
    GET DIAGNOSTICS _got = ROW_COUNT;
    IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped: expected to remove % plan(s), removed %. Nothing was changed.', _expected, _got; END IF;
    _removed := _removed + _got;

    SELECT count(*) INTO _expected FROM public.client_notes WHERE client_id = ANY(_ids);
    DELETE FROM public.client_notes WHERE client_id = ANY(_ids);
    GET DIAGNOSTICS _got = ROW_COUNT;
    IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped: expected to remove % note(s), removed %. Nothing was changed.', _expected, _got; END IF;
  END IF;

  IF _entity IN ('clients', 'properties') THEN
    SELECT count(*) INTO _expected FROM public.properties WHERE id = ANY(_prop_ids);
    DELETE FROM public.properties WHERE id = ANY(_prop_ids);
    GET DIAGNOSTICS _got = ROW_COUNT;
    IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped: expected to remove % address(es), removed %. Nothing was changed.', _expected, _got; END IF;
    _removed := _removed + _got;
  END IF;

  IF _entity = 'dogs' THEN
    SELECT count(*) INTO _expected FROM public.dogs WHERE id = ANY(_ids);
    DELETE FROM public.dogs WHERE id = ANY(_ids);
    GET DIAGNOSTICS _got = ROW_COUNT;
    IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped: expected to remove % pet(s), removed %. Nothing was changed.', _expected, _got; END IF;
    _removed := _removed + _got;
  END IF;

  IF _entity = 'services' THEN
    SELECT count(*) INTO _expected FROM public.subscriptions WHERE id = ANY(_ids);
    DELETE FROM public.subscriptions WHERE id = ANY(_ids);
    GET DIAGNOSTICS _got = ROW_COUNT;
    IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped: expected to remove % plan(s), removed %. Nothing was changed.', _expected, _got; END IF;
    _removed := _removed + _got;
  END IF;

  IF _writes_invoices THEN
    SELECT count(*) INTO _expected FROM public.invoice_line_items WHERE invoice_id = ANY(_inv_ids);
    DELETE FROM public.invoice_line_items WHERE invoice_id = ANY(_inv_ids);
    GET DIAGNOSTICS _got = ROW_COUNT;
    IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped: expected to remove % invoice line(s), removed %. Nothing was changed.', _expected, _got; END IF;

    SELECT count(*) INTO _expected FROM public.invoices WHERE id = ANY(_inv_ids);
    DELETE FROM public.invoices WHERE id = ANY(_inv_ids);
    GET DIAGNOSTICS _got = ROW_COUNT;
    IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped: expected to remove % opening balance(s), removed %. Nothing was changed.', _expected, _got; END IF;
    _removed := _removed + _got;
  END IF;

  IF _entity = 'clients' THEN
    SELECT count(*) INTO _expected FROM public.clients WHERE id = ANY(_ids);
    DELETE FROM public.clients WHERE id = ANY(_ids);
    GET DIAGNOSTICS _got = ROW_COUNT;
    IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped: expected to remove % client(s), removed %. Nothing was changed.', _expected, _got; END IF;
    _removed := _removed + _got;
  END IF;

  UPDATE public.import_batches
     SET stats = COALESCE(stats, '{}'::jsonb) || jsonb_build_object('undone', cardinality(_ids))
   WHERE id = _batch_id;

  RETURN jsonb_build_object('undone', cardinality(_ids), 'removed', _removed);
END;
$function$;

REVOKE ALL ON FUNCTION public.undo_import_batch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_import_batch(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.undo_import_batch(uuid) IS
  'Deletes everything a committed import batch created, in one transaction (#857). Refused when anything from it has visits or payments, when it updated existing clients, and, where it wrote invoices, to a caller without manage_client_billing. Every delete''s row count is checked; a mismatch rolls the whole undo back.';

-- What this file establishes, checked from any starting state.
DO $check$
BEGIN
  IF (
    SELECT count(*) FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'import_source' AND e.enumlabel IN ('gingr', 'moego')
  ) <> 2 THEN
    RAISE EXCEPTION 'import_source is missing gingr or moego';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'clients'
       AND column_name = 'import_extras' AND data_type = 'jsonb'
       AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'clients.import_extras is missing, not jsonb, required, or defaulted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'import_batches'
       AND column_name = 'undone_at' AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'import_batches.undone_at is missing, required, or defaulted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'undo_import_batch' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'undo_import_batch is missing or not SECURITY DEFINER';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
     WHERE routine_schema = 'public' AND routine_name = 'undo_import_batch'
       AND grantee IN ('PUBLIC', 'anon')
  ) THEN
    RAISE EXCEPTION 'undo_import_batch is callable by anon or PUBLIC';
  END IF;
END
$check$;
