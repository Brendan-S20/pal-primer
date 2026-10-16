-- Issue #434: an import preview could be committed twice.
--
-- commitImport checked only that a batch was still 'previewing'. A preview of
-- a file that had already been committed stayed 'previewing' for good, and
-- still offered "Commit import (311 rows)"; a double click, a retry or a
-- second tab ran the same commit twice at once. Either way every client in
-- the file was created again.
--
-- Three columns and three indexes, no new status values. ALTER TYPE ... ADD
-- VALUE cannot be used in the transaction that adds it, and every SQL proof
-- here applies its migration inside a transaction it rolls back (the same
-- reason 20261010010000_five-walks-a-week.sql gives), so the two new states
-- are spelled with columns on the statuses that exist:
--
--   content_hash       SHA-256 of the file's rows, written by previewImport
--                      (src/lib/import-commit-guard.ts, importContentHash).
--   commit_started_at  set by the one UPDATE that claims a commit:
--                        ... SET commit_started_at = now()
--                        WHERE id = $1 AND status = 'previewing'
--                          AND commit_started_at IS NULL
--                      Two commits of one preview are two UPDATEs of one row;
--                      the second waits for the first, re-reads the row and
--                      matches nothing. 'previewing' with this set is shown
--                      as "being committed".
--   superseded_by      the batch that committed the same file first. Set on
--                      a 'cancelled' preview that can no longer commit.
--
-- import_batches_one_commit_per_file is what stops two DIFFERENT previews of
-- one file from both going in: one claimed or committed batch per content
-- hash per business. A failed commit keeps its reservation, since some
-- rows may already have been written. Batches from before this file have no hash and are not in the
-- index; the server matches those by filename, row count and rows instead.
--
-- Nothing here reads or changes an existing row.

ALTER TABLE public.import_batches
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS commit_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by uuid
    REFERENCES public.import_batches(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.import_batches.content_hash IS
  'SHA-256 of the entity and the rows previewed (importContentHash). Same file, same hash.';
COMMENT ON COLUMN public.import_batches.commit_started_at IS
  'When a commit claimed this batch. Set once, by an UPDATE that requires it to be NULL.';
COMMENT ON COLUMN public.import_batches.superseded_by IS
  'The batch that committed the same file first; this preview can no longer commit.';

CREATE UNIQUE INDEX IF NOT EXISTS import_batches_one_commit_per_file
  ON public.import_batches (organization_id, content_hash)
  WHERE content_hash IS NOT NULL
    AND commit_started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS import_batches_content_hash_idx
  ON public.import_batches (organization_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS import_batches_superseded_by_idx
  ON public.import_batches (superseded_by)
  WHERE superseded_by IS NOT NULL;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'import_batches_one_commit_per_file'
       AND i.indisunique AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'import_batches_one_commit_per_file is missing, not unique, or invalid';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'import_batches'
       AND column_name IN ('content_hash', 'commit_started_at', 'superseded_by')
       AND is_nullable = 'YES' AND column_default IS NULL
  ) <> 3 THEN
    RAISE EXCEPTION 'an import_batches column is missing, required, or defaulted';
  END IF;
END
$post$;
