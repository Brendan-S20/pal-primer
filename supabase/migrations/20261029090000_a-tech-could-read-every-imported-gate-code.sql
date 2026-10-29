-- A tech could read every imported gate code (#571, F-08).
--
-- import_rows.raw and import_rows.mapped hold the spreadsheet a business
-- brought over from its old software: every client's name, phone, address
-- and gate code. import_batches holds who imported what and when.
--
-- Both tables were readable by any member of the organization
-- ("org read ...": is_org_member) and writable by anyone can_write_org lets
-- write, which includes the dispatcher. So a tech whose own JWT returns no
-- rows from clients or properties (they see only their own route) could
-- GET /rest/v1/import_rows?select=* and read every gate code the business
-- ever imported, and a dispatcher could edit or delete import rows.
--
-- Every caller in the product is src/lib/imports.functions.ts, and every
-- function there is gated on manage_imports (owner and office manager, via
-- has_permission). The tables now ask the same question the server does:
-- read, insert, update and delete all require manage_imports. Nobody who can
-- use the Imports page loses anything; nobody else can reach the rows.
--
-- The residual path, on purpose: an owner or office manager (manage_imports)
-- still reads raw for as long as the batch exists, which is what the import
-- page shows them. service_role is unaffected. raw is not purged after a
-- commit here; that is a product decision (the "Try again" path in
-- retryImport re-reads it) and is left for its own change.
--
-- The RESTRICTIVE two-step sign-in policy on both tables is untouched.
--
-- Replays into an empty database: policies are dropped if present and
-- created; the check reads pg_policy only. Idempotent.

DROP POLICY IF EXISTS "org read import_batches" ON public.import_batches;
DROP POLICY IF EXISTS "org write import_batches" ON public.import_batches;
DROP POLICY IF EXISTS "org write import_batches (insert)" ON public.import_batches;
DROP POLICY IF EXISTS "org write import_batches (update)" ON public.import_batches;
DROP POLICY IF EXISTS "org write import_batches (delete)" ON public.import_batches;
DROP POLICY IF EXISTS "imports: manage_imports reads batches" ON public.import_batches;
DROP POLICY IF EXISTS "imports: manage_imports adds batches" ON public.import_batches;
DROP POLICY IF EXISTS "imports: manage_imports changes batches" ON public.import_batches;
DROP POLICY IF EXISTS "imports: manage_imports removes batches" ON public.import_batches;

CREATE POLICY "imports: manage_imports reads batches" ON public.import_batches
  FOR SELECT TO authenticated
  USING (has_permission((select auth.uid()), organization_id, 'manage_imports'::text));
CREATE POLICY "imports: manage_imports adds batches" ON public.import_batches
  FOR INSERT TO authenticated
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_imports'::text));
CREATE POLICY "imports: manage_imports changes batches" ON public.import_batches
  FOR UPDATE TO authenticated
  USING (has_permission((select auth.uid()), organization_id, 'manage_imports'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_imports'::text));
CREATE POLICY "imports: manage_imports removes batches" ON public.import_batches
  FOR DELETE TO authenticated
  USING (has_permission((select auth.uid()), organization_id, 'manage_imports'::text));

DROP POLICY IF EXISTS "org read import_rows" ON public.import_rows;
DROP POLICY IF EXISTS "org write import_rows" ON public.import_rows;
DROP POLICY IF EXISTS "org write import_rows (insert)" ON public.import_rows;
DROP POLICY IF EXISTS "org write import_rows (update)" ON public.import_rows;
DROP POLICY IF EXISTS "org write import_rows (delete)" ON public.import_rows;
DROP POLICY IF EXISTS "imports: manage_imports reads rows" ON public.import_rows;
DROP POLICY IF EXISTS "imports: manage_imports adds rows" ON public.import_rows;
DROP POLICY IF EXISTS "imports: manage_imports changes rows" ON public.import_rows;
DROP POLICY IF EXISTS "imports: manage_imports removes rows" ON public.import_rows;

CREATE POLICY "imports: manage_imports reads rows" ON public.import_rows
  FOR SELECT TO authenticated
  USING (has_permission((select auth.uid()), organization_id, 'manage_imports'::text));
CREATE POLICY "imports: manage_imports adds rows" ON public.import_rows
  FOR INSERT TO authenticated
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_imports'::text));
CREATE POLICY "imports: manage_imports changes rows" ON public.import_rows
  FOR UPDATE TO authenticated
  USING (has_permission((select auth.uid()), organization_id, 'manage_imports'::text))
  WITH CHECK (has_permission((select auth.uid()), organization_id, 'manage_imports'::text));
CREATE POLICY "imports: manage_imports removes rows" ON public.import_rows
  FOR DELETE TO authenticated
  USING (has_permission((select auth.uid()), organization_id, 'manage_imports'::text));

-- What this migration establishes, provable from any starting state: every
-- PERMISSIVE policy on the two tables asks manage_imports, and nothing else
-- grants access to them.
DO $check$
DECLARE
  _bad text;
BEGIN
  SELECT string_agg(c.relname || ': ' || p.polname, ', ')
    INTO _bad
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('import_batches', 'import_rows')
     AND p.polpermissive
     AND coalesce(pg_get_expr(p.polqual, p.polrelid), '')
         || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') NOT LIKE '%manage_imports%';
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'import tables still have a permissive policy that does not ask manage_imports: %', _bad;
  END IF;

  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('import_batches', 'import_rows')
        AND p.polpermissive) <> 8 THEN
    RAISE EXCEPTION 'expected exactly 8 permissive policies on import_batches and import_rows';
  END IF;
END
$check$;
