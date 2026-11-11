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
-- Three things this file establishes, nothing it reads:
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
--   import_batches.undone_at is set by undoImport once everything a
--   committed batch created has been deleted. Undo is refused while anything
--   from the batch has visits or payments, and for a batch that updated
--   clients the business already had (src/lib/import-leftovers.ts,
--   undoRefusal). An undone batch keeps its rows and its hash, and is left
--   out of the "this file was already imported" check, so the file can be
--   imported again.
--
-- ALTER TYPE ... ADD VALUE is allowed inside a transaction; the new value
-- only cannot be USED in the same transaction, and nothing here uses it.
-- Replays into an empty database: every statement is IF NOT EXISTS.

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
  'When undoImport deleted everything this committed batch created. The batch '
  'keeps its rows and content_hash and no longer counts as having imported the file.';

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
END
$check$;
