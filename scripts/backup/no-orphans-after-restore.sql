-- Every foreign key in the app's schemas still holds after a restore.
--
-- Run by scripts/backup/verify-restore.mjs against the RESTORED database.
--
-- Why this is needed when the dump came from a database that enforces its
-- foreign keys: the restore loads rows with session_replication_role =
-- replica, and in Postgres a foreign key IS a pair of system triggers. Replica
-- mode switches them off along with every other trigger, so nothing checks a
-- single reference while the data lands, and the constraints stay marked
-- VALID regardless. A dump that left a table out -- an exclusion added to
-- dump.sh, a schema the CLI decided was internal -- would restore "cleanly"
-- with every child of that table pointing at nothing, and the row counts
-- would all match.
--
-- So each constraint is re-checked by query. Only counts and constraint names
-- are reported: this runs in CI, and a key value would be customer data.
-- MATCH SIMPLE semantics, which is what every FK here uses: a row with ANY
-- referencing column null is not checked.
DO $$
DECLARE
  c record;
  not_null text;
  joined text;
  n bigint;
  bad integer := 0;
  checked integer := 0;
BEGIN
  FOR c IN
    SELECT con.conname,
           con.conrelid::regclass  AS child,
           con.confrelid::regclass AS parent,
           con.conkey, con.confkey, con.conrelid, con.confrelid
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE con.contype = 'f'
       AND ns.nspname IN ('public', 'reference')
     ORDER BY con.conrelid::regclass::text, con.conname
  LOOP
    SELECT string_agg(format('ch.%I IS NOT NULL', a.attname), ' AND ' ORDER BY k.i)
      INTO not_null
      FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, i)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum;
    SELECT string_agg(format('pa.%I = ch.%I', pa.attname, ch.attname), ' AND ' ORDER BY k.i)
      INTO joined
      FROM unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(ch_att, pa_att, i)
      JOIN pg_attribute ch ON ch.attrelid = c.conrelid AND ch.attnum = k.ch_att
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.pa_att;

    EXECUTE format(
      'SELECT count(*) FROM %s ch WHERE %s AND NOT EXISTS (SELECT 1 FROM %s pa WHERE %s)',
      c.child, not_null, c.parent, joined)
      INTO n;
    checked := checked + 1;
    IF n > 0 THEN
      bad := bad + 1;
      RAISE WARNING 'orphans: % row(s) of % reference a missing % (constraint %)', n, c.child, c.parent, c.conname;
    END IF;
  END LOOP;

  IF checked = 0 THEN
    -- Nothing to check is not a pass. A restore with no foreign keys in public
    -- did not restore this app's schema.
    RAISE EXCEPTION 'no foreign keys found in public/reference -- the schema did not restore';
  END IF;
  IF bad > 0 THEN
    RAISE EXCEPTION '% of % foreign keys have orphaned rows after the restore (listed above)', bad, checked;
  END IF;
  RAISE NOTICE 'all % foreign keys in public/reference hold', checked;
END
$$;
