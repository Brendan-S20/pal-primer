-- Nobody knew what a route cost.
--
-- The accountant's pack said so itself, in its list of gaps: "Expenses are
-- not tracked." A pet-waste operator's real costs are fuel, dump and disposal
-- fees, bags and supplies, equipment, vehicle maintenance and mileage, and
-- every one of them lived in a shoebox or a spreadsheet beside this product.
-- Jobber tracks them. An owner switching over lost them.
--
-- ── WHAT THIS FILE ESTABLISHES ─────────────────────────────────────────────
--
--   * organizations.mileage_rate_cents: the org's rate per mile, in cents
--     (numeric, because the IRS rate can carry a half cent: it was 72.5 for the first half of 2026 and 76 from 2026-07-01).
--     Defaults to the IRS standard business rate.
--
--   * public.expenses: one row per expense. `spent_on` is a DATE, a day on the
--     organization's own calendar, never a timestamp -- the same rule every
--     other date column in this schema follows, and the one that stops an
--     expense at 7pm on 31 December landing in the next tax year.
--
--   * A mileage row stores the miles AND the rate it was priced at. The rate is
--     taken from the organization when the row is written and never again, so
--     changing the org's rate in January does not reprice last year's miles --
--     a figure that has been filed must not move. The trigger computes the
--     amount; the client's arithmetic is a preview and is not believed. A
--     CHECK pins amount = round(miles x rate) on every mileage row, so no path
--     (a service-role script included) can store a mileage row that does not
--     add up.
--
--   * RLS, one permissive policy per command:
--       office  owner and office manager (has_permission 'view_financials',
--               the permission /reports and the accountant's pack already
--               ask) read and write every expense in their organization;
--       own     anybody else reads and writes only the rows whose staff_id is
--               their own active staff row -- a tech sees their own fuel
--               receipts and nobody else's, and cannot file one against
--               another tech or another organization.
--     anon has nothing.
--
--   * The `expense-receipts` bucket, private, created HERE rather than at a
--     console. visit-photos existed only in production for months (see
--     20260928020000) and every fresh build answered "Bucket not found".
--     Objects are filed {organization_id}/{staff_id or "office"}/{expense_id}.ext,
--     and the storage policies read (storage.foldername(name))[1] as the org
--     id, exactly as the visit-photos policies do, through one helper so the
--     four commands cannot drift apart:
--       office  anything in their org's folder;
--       own     their own staff folder, and to READ, any receipt on an
--               expense that is theirs wherever the office filed it.
--     UPDATE is granted as INSERT is, because the offline replay uploads with
--     upsert -- the lesson of 20260903110000, where a missing UPDATE policy
--     turned every retry into a permanent refusal.
--
-- Replays into an empty database: one column, one table, two functions, one
-- trigger, a bucket row and eight policies. Every assertion at the bottom is
-- about what this file creates; none needs a tenant or a row.

-- ── The org's rate ──────────────────────────────────────────────────────────

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS mileage_rate_cents numeric(6,2) NOT NULL DEFAULT 76.00;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_mileage_rate_cents_range;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_mileage_rate_cents_range
  CHECK (mileage_rate_cents > 0 AND mileage_rate_cents < 1000);

COMMENT ON COLUMN public.organizations.mileage_rate_cents IS
  'Cents per mile a mileage expense is priced at when it is logged. Defaults to the IRS standard business rate (76 cents from 2026-07-01). Each expense keeps the rate it was priced at, so changing this never reprices history.';

-- ── The table ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expenses (
  -- Minted on the device for a field expense, so an offline replay of a
  -- request that had in fact landed is the same row, not a second one.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Whose expense it is, when it is anybody's. SET NULL rather than CASCADE:
  -- a tech who leaves does not take the business's fuel costs with them.
  staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  spent_on date NOT NULL,
  category text NOT NULL,
  amount_cents integer NOT NULL,
  miles numeric(7,1),
  mileage_rate_cents numeric(6,2),
  vendor text,
  note text,
  receipt_path text,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_category CHECK (category IN (
    'fuel', 'disposal', 'supplies', 'equipment', 'vehicle_maintenance', 'mileage', 'other'
  )),
  -- Seven figures of dollars and change, and never zero or negative: a refund
  -- from a vendor is not an expense and does not belong in this sum.
  CONSTRAINT expenses_amount_range CHECK (amount_cents BETWEEN 1 AND 999999999),
  CONSTRAINT expenses_mileage_shape CHECK (
    (category = 'mileage') = (miles IS NOT NULL AND mileage_rate_cents IS NOT NULL)
  ),
  CONSTRAINT expenses_mileage_adds_up CHECK (
    category <> 'mileage' OR amount_cents = round(miles * mileage_rate_cents)::integer
  ),
  CONSTRAINT expenses_miles_range CHECK (miles IS NULL OR (miles > 0 AND miles <= 100000)),
  CONSTRAINT expenses_vendor_length CHECK (vendor IS NULL OR char_length(vendor) <= 120),
  CONSTRAINT expenses_note_length CHECK (note IS NULL OR char_length(note) <= 500),
  -- A receipt is filed under the expense's own organization, and nowhere else.
  CONSTRAINT expenses_receipt_in_org_folder CHECK (
    receipt_path IS NULL OR starts_with(receipt_path, organization_id::text || '/')
  )
);

COMMENT ON TABLE public.expenses IS
  'Business expenses: fuel, disposal fees, supplies, equipment, vehicle maintenance, mileage and other. spent_on is a day on the org''s calendar. Office roles (view_financials) read and write the org''s rows; anyone else only rows whose staff_id is their own.';
COMMENT ON COLUMN public.expenses.mileage_rate_cents IS
  'The rate this mileage row was priced at, taken from organizations.mileage_rate_cents when it was logged and never changed after.';

-- The page reads a month of an org by day; the tech's list reads their own.
CREATE INDEX IF NOT EXISTS expenses_org_spent_on ON public.expenses (organization_id, spent_on);
-- Every foreign key indexed. organization_id leads the index above.
CREATE INDEX IF NOT EXISTS expenses_staff_spent_on ON public.expenses (staff_id, spent_on)
  WHERE staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_created_by ON public.expenses (created_by)
  WHERE created_by IS NOT NULL;
-- The storage read policy asks "is this object the receipt on one of my
-- expenses?" by path.
CREATE INDEX IF NOT EXISTS expenses_receipt_path ON public.expenses (receipt_path)
  WHERE receipt_path IS NOT NULL;

-- ── The rules every write obeys, whoever writes ─────────────────────────────

CREATE OR REPLACE FUNCTION public.expenses_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Tenancy and provenance do not move.
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'An expense cannot be moved to another organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
  ELSIF auth.uid() IS NOT NULL THEN
    -- Whoever is signed in wrote it, whatever the payload claimed.
    NEW.created_by := auth.uid();
  END IF;

  -- The person it belongs to is in the same organization. The policies check
  -- the caller; this checks the row, for the office too.
  IF NEW.staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.staff s
     WHERE s.id = NEW.staff_id AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'That team member is not in this organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.category = 'mileage' THEN
    IF NEW.miles IS NULL OR NEW.miles <= 0 THEN
      RAISE EXCEPTION 'A mileage expense needs the miles driven';
    END IF;
    -- The rate snapshot. Taken from the org when the row becomes a mileage
    -- row, kept for ever after: editing the miles on last March's trip prices
    -- them at last March's rate.
    IF TG_OP = 'INSERT' OR OLD.category IS DISTINCT FROM 'mileage' THEN
      SELECT o.mileage_rate_cents INTO NEW.mileage_rate_cents
        FROM public.organizations o
       WHERE o.id = NEW.organization_id;
    ELSE
      NEW.mileage_rate_cents := OLD.mileage_rate_cents;
    END IF;
    -- round(numeric) is half away from zero, and exact: 12.3 miles at 72.5
    -- is 891.75 and becomes 892. See mileageAmountCents in src/lib/expenses.ts,
    -- which has to agree to the cent and cannot use floating point to do it.
    NEW.amount_cents := round(NEW.miles * NEW.mileage_rate_cents)::integer;
  ELSE
    NEW.miles := NULL;
    NEW.mileage_rate_cents := NULL;
  END IF;

  NEW.vendor := NULLIF(btrim(COALESCE(NEW.vendor, '')), '');
  NEW.note := NULLIF(btrim(COALESCE(NEW.note, '')), '');
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.expenses_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS expenses_before_write ON public.expenses;
CREATE TRIGGER expenses_before_write
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.expenses_before_write();

-- ── Who may read and write ──────────────────────────────────────────────────

-- "Is this staff row the caller's own, in this organization, and are they
-- still on the team?" Asked of the CALLER only: it takes no user id, so it
-- cannot be used to ask about anybody else.
CREATE OR REPLACE FUNCTION public.is_own_staff_row(_staff_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND _staff_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.staff s
         JOIN public.user_roles ur
           ON ur.user_id = s.user_id AND ur.organization_id = s.organization_id
        WHERE s.id = _staff_id
          AND s.organization_id = _org_id
          AND s.user_id = auth.uid()
          AND s.active
     );
$function$;

REVOKE ALL ON FUNCTION public.is_own_staff_row(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_own_staff_row(uuid, uuid) TO authenticated, service_role;

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.expenses FROM anon;
REVOKE ALL ON public.expenses FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expenses TO authenticated;
GRANT ALL ON public.expenses TO service_role;

DROP POLICY IF EXISTS "Office reads the org's expenses, others their own" ON public.expenses;
CREATE POLICY "Office reads the org's expenses, others their own" ON public.expenses
  FOR SELECT TO authenticated
  USING (
    public.has_permission((SELECT auth.uid()), organization_id, 'view_financials')
    OR public.is_own_staff_row(staff_id, organization_id)
  );

DROP POLICY IF EXISTS "Office logs the org's expenses, others their own" ON public.expenses;
CREATE POLICY "Office logs the org's expenses, others their own" ON public.expenses
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_permission((SELECT auth.uid()), organization_id, 'view_financials')
    OR public.is_own_staff_row(staff_id, organization_id)
  );

-- WITH CHECK as well as USING: a tech may edit their own row, and may not
-- edit it into somebody else's.
DROP POLICY IF EXISTS "Office edits the org's expenses, others their own" ON public.expenses;
CREATE POLICY "Office edits the org's expenses, others their own" ON public.expenses
  FOR UPDATE TO authenticated
  USING (
    public.has_permission((SELECT auth.uid()), organization_id, 'view_financials')
    OR public.is_own_staff_row(staff_id, organization_id)
  )
  WITH CHECK (
    public.has_permission((SELECT auth.uid()), organization_id, 'view_financials')
    OR public.is_own_staff_row(staff_id, organization_id)
  );

DROP POLICY IF EXISTS "Office deletes the org's expenses, others their own" ON public.expenses;
CREATE POLICY "Office deletes the org's expenses, others their own" ON public.expenses
  FOR DELETE TO authenticated
  USING (
    public.has_permission((SELECT auth.uid()), organization_id, 'view_financials')
    OR public.is_own_staff_row(staff_id, organization_id)
  );

-- ── Receipts ────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-receipts', 'expense-receipts', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- One answer for all four storage commands. Reads the first folder as the org
-- id, as the visit-photos policies do, but only after checking it IS a uuid:
-- a cast in a policy raises on a malformed name rather than refusing it, and
-- Postgres does not promise to test `bucket_id = ...` first.
CREATE OR REPLACE FUNCTION public.can_use_expense_receipt(_name text, _write boolean)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _folders text[] := storage.foldername(_name);
  _org uuid;
BEGIN
  IF _uid IS NULL
     OR _folders[1] IS NULL
     OR _folders[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  _org := _folders[1]::uuid;

  -- The office: anything filed under its organization.
  IF public.has_permission(_uid, _org, 'view_financials') THEN
    RETURN true;
  END IF;

  -- Anyone on the team: their own folder, {org}/{their staff id}/...
  IF EXISTS (
    SELECT 1
      FROM public.staff s
      JOIN public.user_roles ur
        ON ur.user_id = s.user_id AND ur.organization_id = s.organization_id
     WHERE s.user_id = _uid
       AND s.organization_id = _org
       AND s.active
       AND s.id::text = _folders[2]
  ) THEN
    RETURN true;
  END IF;

  -- Reading only: the receipt on an expense that is theirs, wherever the
  -- office filed it.
  IF NOT _write AND EXISTS (
    SELECT 1
      FROM public.expenses e
     WHERE e.receipt_path = _name
       AND e.organization_id = _org
       AND public.is_own_staff_row(e.staff_id, e.organization_id)
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.can_use_expense_receipt(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_use_expense_receipt(text, boolean) TO authenticated, service_role;

DROP POLICY IF EXISTS "expense receipts: office and owner read" ON storage.objects;
CREATE POLICY "expense receipts: office and owner read"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'expense-receipts' AND public.can_use_expense_receipt(name, false));

DROP POLICY IF EXISTS "expense receipts: office and owner upload" ON storage.objects;
CREATE POLICY "expense receipts: office and owner upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'expense-receipts' AND public.can_use_expense_receipt(name, true));

DROP POLICY IF EXISTS "expense receipts: office and owner overwrite" ON storage.objects;
CREATE POLICY "expense receipts: office and owner overwrite"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'expense-receipts' AND public.can_use_expense_receipt(name, true))
  WITH CHECK (bucket_id = 'expense-receipts' AND public.can_use_expense_receipt(name, true));

DROP POLICY IF EXISTS "expense receipts: office and owner delete" ON storage.objects;
CREATE POLICY "expense receipts: office and owner delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'expense-receipts' AND public.can_use_expense_receipt(name, true));

-- ── What this file establishes ──────────────────────────────────────────────
DO $check$
DECLARE
  _fk record;
  _fn text;
  _cmd text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'mileage_rate_cents' AND column_default LIKE '76%'
  ) THEN
    RAISE EXCEPTION 'organizations.mileage_rate_cents is missing or does not default to 76.00';
  END IF;

  IF to_regclass('public.expenses') IS NULL THEN
    RAISE EXCEPTION 'public.expenses was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.expenses'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on public.expenses';
  END IF;
  IF has_table_privilege('anon', 'public.expenses', 'SELECT')
     OR has_table_privilege('anon', 'public.expenses', 'INSERT')
     OR has_table_privilege('anon', 'public.expenses', 'UPDATE')
     OR has_table_privilege('anon', 'public.expenses', 'DELETE') THEN
    RAISE EXCEPTION 'anon has a privilege on public.expenses';
  END IF;

  -- One policy per command, each for authenticated only.
  FOREACH _cmd IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'expenses' AND cmd = _cmd
           AND roles = ARRAY['authenticated']::name[]) <> 1 THEN
      RAISE EXCEPTION 'public.expenses does not have exactly one % policy for authenticated', _cmd;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'expenses'
       AND roles <> ARRAY['authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'public.expenses has a policy for a role other than authenticated';
  END IF;

  -- Every foreign key has an index that leads with its column.
  FOR _fk IN
    SELECT con.conname, con.conkey[1] AS attnum
      FROM pg_constraint con
     WHERE con.conrelid = 'public.expenses'::regclass AND con.contype = 'f'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = 'public.expenses'::regclass
         AND i.indkey[0] = _fk.attnum
         AND i.indisvalid
    ) THEN
      RAISE EXCEPTION 'foreign key % on expenses has no index', _fk.conname;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.expenses'::regclass
       AND tgname = 'expenses_before_write' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the expenses write trigger is missing';
  END IF;

  -- The bucket, private, and all four commands on it.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'expense-receipts' AND NOT public) THEN
    RAISE EXCEPTION 'expense-receipts bucket missing, or public';
  END IF;
  FOREACH _cmd IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = _cmd
         AND roles = ARRAY['authenticated']::name[]
         AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%expense-receipts%can_use_expense_receipt%'
    ) THEN
      RAISE EXCEPTION 'expense-receipts has no % policy on storage.objects', _cmd;
    END IF;
  END LOOP;

  -- The helpers: callable by the signed-in (a policy runs as its caller), by
  -- nobody else, definer-rights with a fixed search_path.
  FOREACH _fn IN ARRAY ARRAY[
    'public.is_own_staff_row(uuid, uuid)',
    'public.can_use_expense_receipt(text, boolean)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute %', _fn;
    END IF;
    IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated cannot execute %, and the policies call it as authenticated', _fn;
    END IF;
  END LOOP;
  FOREACH _fn IN ARRAY ARRAY[
    'public.is_own_staff_row(uuid, uuid)',
    'public.can_use_expense_receipt(text, boolean)',
    'public.expenses_before_write()'
  ] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = _fn::regprocedure) THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER', _fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc, unnest(proconfig) AS cfg
       WHERE oid = _fn::regprocedure AND cfg LIKE 'search_path=%'
    ) THEN
      RAISE EXCEPTION '% has no fixed search_path', _fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.expenses_before_write()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.expenses_before_write()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the expenses trigger function is callable as an RPC';
  END IF;
END
$check$;
