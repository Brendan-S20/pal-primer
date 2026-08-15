-- The advisor found 93 foreign keys with no covering index. Fifteen of them
-- are on a path that deletes a parent row in bulk. The other 78 are noise on
-- this schema, and adding them would be a write tax paid forever against a
-- cost nothing in this product ever incurs.
--
-- ── WHAT AN UNINDEXED FOREIGN KEY ACTUALLY COSTS ───────────────────────────
--
-- Nothing, on the INSERT side. The child's own insert checks the PARENT's key,
-- and that is the parent's primary key, which is always indexed. The advisor's
-- INFO is not about writing children.
--
-- It is about deleting parents. When a parent row goes away — or its key is
-- updated — Postgres has to answer "does any child still point at this?", and
-- the referential-integrity trigger answers it with, per parent row:
--
--   SELECT 1 FROM child x WHERE x.fkcol = $1 FOR KEY SHARE OF x;
--
-- once for every row removed. With a covering index that is a single btree
-- descent. Without one it is a sequential scan of the entire child table, and
-- it happens N times for an N-row delete — so a delete of 3,000 parents against
-- a 1,000,000-row child is 3,000 full scans of a million rows, not one. The
-- delete action decides whether there is also a write on the end of it:
-- CASCADE deletes the rows it found, SET NULL updates them, NO ACTION and
-- RESTRICT only need to know whether any exist — but all four have to FIND
-- them first, and finding them is the part an index fixes.
--
-- Against that: every index is paid on every INSERT and on every UPDATE that
-- cannot go HOT, forever, plus its storage and its share of every vacuum. This
-- product's hot path is a tech writing visits all day. `visits` already carries
-- six indexes against 4,691 inserts and 7,522 updates in the last stats window,
-- and it is the table that grows without limit. Two more indexes on it is a
-- real decision, not a formality. Ninety-three would be an act of vandalism
-- dressed up as compliance with an INFO-level lint.
--
-- ── THE EVIDENCE THAT ANY PARENT IS DELETED IN BULK AT ALL ─────────────────
--
-- On most SaaS schemas the honest answer to "is the parent ever deleted?" is
-- no, and the whole lint is moot. Not here, and the reason is `seed_demo_org`
-- — the reseed button, reachable by any owner or office_manager. Before it
-- writes anything it wipes the organization, and its own comment says what
-- that costs: "The order is FK order ... addon_subscriptions holds the only two
-- edges in this graph that neither cascade nor null out ... Both are deleted
-- below, so it has to go first or the whole reseed aborts on a foreign key —
-- which is exactly what the first dry run did."
--
-- That function issues twenty-one org-scoped DELETEs in a row, including
--
--   DELETE FROM public.visits        WHERE organization_id = _org_id;
--   DELETE FROM public.properties    WHERE organization_id = _org_id;
--   DELETE FROM public.clients       WHERE organization_id = _org_id;
--   DELETE FROM public.zones         WHERE organization_id = _org_id;
--
-- and `visits` is 3,517 rows in one of those statements today. Every one of
-- those 3,517 rows fires the RI probe above against every child of `visits`
-- that has no index — credit_ledger, messages, qc_tickets — and the properties
-- and zones statements do the same against `visits` itself. This is not a
-- hypothetical delete path found by reading DDL. It is a button, and the churn
-- counters show it being pressed: `credit_ledger` holds 92 live rows and has
-- taken 28,538 inserts.
--
-- The app deletes these same parents outside the reseeder too — properties,
-- clients, zones, subscriptions, invoices, waste_stations and visits all have
-- a `.delete()` in `src/`, and the migration corpus has ten `DELETE FROM
-- invoices` and eight `DELETE FROM visits`.
--
-- Corroborating, though not proof on its own: the sequential-scan counters on
-- exactly these child tables are far larger than anything the product reads
-- them with. Over the 40 days since the stats reset on 2026-06-30,
-- `inventory_movements` has one insert, 29 index scans and 3,231 sequential
-- scans; `messages` has two inserts and 3,204; `qc_tickets` 3,199; `waste_
-- stations` 4,015 sequential against 180 index. Nothing in the UI reads an
-- empty inventory table three thousand times. That is FK enforcement.
--
-- ── MEASURED, BEFORE WRITING ANY OF THIS ───────────────────────────────────
--
-- The probe shape above, run against the live database. On `visits`:
--
--   LockRows (actual time=0.869..0.870 rows=0 loops=1)
--     ->  Seq Scan on visits x
--           Filter: (property_id = '...'::uuid)
--           Rows Removed by Filter: 3517
--           Buffers: shared hit=108
--
-- 108 buffers and 3,517 rows examined, to learn that a property has no visits.
-- Multiply by one delete per property. The absolute number is small — 0.9ms —
-- and it is small because this database has three demo organizations in it.
-- The shape is the point: it is O(rows in visits) per parent row, and `visits`
-- is the table with no ceiling.
--
-- Two of the fifteen are NOT heap scans today, and the measurement is why they
-- are described honestly rather than lumped in. `station_service_logs.waste_
-- station_id` is the second column of `station_service_logs_visit_id_waste_
-- station_id_key`, so the planner degrades to a full scan of that index rather
-- than of the heap:
--
--   ->  Index Scan using station_service_logs_visit_id_waste_station_id_key
--         Index Cond: (waste_station_id = '...'::uuid)
--
-- Cheaper than a seq scan, still O(n) per parent row. `addon_charges.client_id`
-- is the same case inside `addon_charges_organization_id_client_id_status_idx`.
-- The other thirteen have the column in no index at all.
--
-- No claim is made here that any of this is measurably faster for a user
-- today. On three demo orgs it is not, and a benchmark saying otherwise would
-- be measuring noise. What these fifteen buy is that the reseed and the
-- offboard stay linear in the rows they delete instead of quadratic in the
-- table they delete from, at a size this database has not reached yet.
--
-- ── THE RULE, AND THE 78 IT REJECTS ────────────────────────────────────────
--
-- An index goes in only where BOTH halves are true: the parent is deleted or
-- re-keyed on a path that exists in this repo, AND the child either grows
-- without bound or uses the column as a read filter. One without the other is
-- not enough — a bulk delete against a settings table costs nothing, and a
-- read key on a table nothing deletes from is a query-tuning question, not
-- this one.
--
-- That leaves 78 rejected, in four groups:
--
--   21  the parent is `auth.users`. Staff are deactivated in this product, not
--       deleted — `seed_demo_org` says so in its own comment: "Staff rows are
--       NOT wiped: they carry user_id and are what the demo logins resolve
--       to." Sixteen of the 21 are `created_by`/`invited_by`/`resolved_by`
--       provenance stamps that no query in `src/` ever filters on, and eleven
--       are NO ACTION, so the rare real account deletion raises rather than
--       scanning-and-writing. Cheap to revisit if account deletion ever
--       becomes a routine operation.
--
--   31  the child is niche or grows with the customer list rather than without
--       bound — dna_matches, unit_incidents, inventory_movements, addon_*,
--       ai_receptionist_logs, neighbor_leads, waste_disposal_manifests,
--       gift_card_redemptions. Several of these features have single-digit
--       row counts after 40 days. Indexing an unshipped feature's log table
--       is speculation.
--
--   20  the child is an admin, config or session table that stays small
--       forever — platform_*, franchise_*, oauth_states, portal_sessions,
--       import_batches, signup_requests, push_subscriptions. A sequential scan
--       of a table that will never hold four figures is not a cost.
--
--    6  the parent is effectively immortal: platform_plans, platform_feature_
--       flags, platform_addons, waste_disposal_facilities, and organizations
--       where the child is itself small. Nothing deletes a plan.
--
-- Two rejections are close and are named so the next person does not have to
-- rediscover them. `properties.zone_id` and `properties.auto_zone_id` are real
-- CASCADE-adjacent edges from a table that IS deleted (zones), and they are
-- rejected only because `properties` is bounded by the customer count and
-- already answers 32,410 index scans against 122 sequential ones. And
-- `credit_ledger.promo_code_id` sits on a table that IS in the accept list
-- twice — it is rejected because promo codes are few and deleted rarely, where
-- visits and invoices are deleted in thousands.
--
-- ── NAMING ─────────────────────────────────────────────────────────────────
--
-- This schema has two conventions, `idx_<table>_<col>` and `<table>_<col>_idx`,
-- split 35/49 across the corpus, and they are not distributed randomly — they
-- are consistent PER TABLE. `visits` has idx_visits_client and
-- idx_visits_org_date; `credit_ledger` has credit_ledger_client_idx and
-- credit_ledger_org_idx. Each index below follows the convention already in
-- use on the table it sits on, so no table ends up with both.
--
-- ── CONCURRENTLY ───────────────────────────────────────────────────────────
--
-- Deliberately not used. CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block and every migration here runs in one, so writing it would
-- produce a file that fails on apply. The plain form takes ACCESS EXCLUSIVE on
-- the table for the duration of the build, which on the largest table involved
-- — 3,517 rows, 108 pages — is single-digit milliseconds. If this file is ever
-- replayed onto a database where these tables are large, do not run it as-is:
-- run the fifteen statements by hand, one per transaction, with CONCURRENTLY
-- added and IF NOT EXISTS kept, then re-run the DO $post$ block on its own to
-- confirm. A CONCURRENTLY build that fails leaves an INVALID index behind,
-- which the $post$ check below would not catch, so also confirm indisvalid.

DO $pre$
DECLARE
  _unindexed int;
  _r record;
  _def text;
BEGIN
  -- The finding this file answers. If it is no longer 93 the schema has moved
  -- underneath the reasoning above and the buckets need re-counting.
  SELECT count(*) INTO _unindexed
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
   WHERE c.contype = 'f' AND n.nspname = 'public'
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = c.conrelid
          AND (i.indkey::smallint[])[0:array_length(c.conkey,1)-1] = c.conkey);
  IF _unindexed <> 93 THEN
    RAISE WARNING 'expected 93 unindexed foreign keys in public, found %', _unindexed;
  END IF;

  -- Every one of the fifteen must genuinely lack a leading-column index, or
  -- this file is claiming to fix something that is already fixed.
  FOR _r IN
    SELECT * FROM (VALUES
      ('visits','property_id'), ('visits','zone_id'),
      ('credit_ledger','visit_id'), ('credit_ledger','invoice_id'),
      ('station_service_logs','waste_station_id'), ('station_service_logs','organization_id'),
      ('messages','visit_id'), ('qc_tickets','visit_id'),
      ('invoice_line_items','subscription_id'), ('subscriptions','property_id'),
      ('client_notes','property_id'), ('waste_stations','client_id'),
      ('waste_stations','organization_id'), ('addon_charges','client_id'),
      ('payments','organization_id')
    ) AS t(tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = ('public.' || _r.tbl)::regclass
         AND i.indkey[0] = (SELECT attnum FROM pg_attribute
                             WHERE attrelid = ('public.' || _r.tbl)::regclass
                               AND attname = _r.col)
    ) THEN
      RAISE EXCEPTION '%.% already has a leading-column index', _r.tbl, _r.col;
    END IF;
  END LOOP;

  -- The delete actions the reasoning turns on. A CASCADE that has quietly
  -- become RESTRICT changes what the missing index costs.
  IF (SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'public.visits'::regclass AND contype = 'f'
         AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid='public.visits'::regclass AND attname='property_id')]::smallint[]
     ) <> 'c' THEN
    RAISE EXCEPTION 'visits.property_id is no longer ON DELETE CASCADE';
  END IF;
  IF (SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'public.visits'::regclass AND contype = 'f'
         AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid='public.visits'::regclass AND attname='zone_id')]::smallint[]
     ) <> 'n' THEN
    RAISE EXCEPTION 'visits.zone_id is no longer ON DELETE SET NULL';
  END IF;

  -- The bulk-delete path the whole file rests on. If the reseeder stops wiping
  -- the org, fourteen of these fifteen lose most of their justification.
  _def := pg_get_functiondef('public.seed_demo_org(uuid)'::regprocedure);
  IF _def NOT LIKE '%DELETE FROM public.visits%WHERE organization_id = _org_id%' THEN
    RAISE EXCEPTION 'seed_demo_org no longer bulk-deletes visits; re-read this file before applying';
  END IF;
END
$pre$;

-- ── THE FIFTEEN ────────────────────────────────────────────────────────────
--
-- Single-column, deliberately. A wider index would also satisfy the foreign
-- key as long as the FK column leads, and for three of these there is an
-- obvious composite that would serve a dashboard query too. That is a separate
-- exercise and it should be driven by measured plans on a database with real
-- data in it, not bolted onto a file about referential integrity. The narrow
-- form is the cheapest thing that removes the sequential scan.

-- visits is the unbounded table and the hot write path; these two are the only
-- indexes this file adds to it. properties are deleted by the reseeder and by
-- src/, CASCADE, and property_id is the most-used FK filter in the app (22
-- call sites) — the property detail screen's visit history is this index.
CREATE INDEX IF NOT EXISTS idx_visits_property ON public.visits (property_id);
-- SET NULL, so deleting a zone must find every visit in it and then write to
-- each one. Redrawing a service area is an ordinary operator action.
CREATE INDEX IF NOT EXISTS idx_visits_zone ON public.visits (zone_id);

-- credit_ledger is append-only and unbounded — one row per prepaid visit plus
-- every top-up. Both parents are deleted in thousands.
CREATE INDEX IF NOT EXISTS credit_ledger_visit_idx ON public.credit_ledger (visit_id);
CREATE INDEX IF NOT EXISTS credit_ledger_invoice_idx ON public.credit_ledger (invoice_id);

-- One row per station per visit — the fastest-growing child in the schema for
-- a commercial operator. The waste_station_id probe currently degrades to a
-- full scan of the (visit_id, waste_station_id) unique index; organization_id
-- is in no index at all, which is also why this table answers org-scoped reads
-- with 1,578 sequential scans.
CREATE INDEX IF NOT EXISTS idx_station_logs_station ON public.station_service_logs (waste_station_id);
CREATE INDEX IF NOT EXISTS idx_station_logs_org ON public.station_service_logs (organization_id);

-- Both unbounded, both children of visits, both SET NULL.
CREATE INDEX IF NOT EXISTS messages_visit_id_idx ON public.messages (visit_id);
CREATE INDEX IF NOT EXISTS qc_tickets_visit_idx ON public.qc_tickets (visit_id);

-- One line item per billed visit, so unbounded; subscriptions are deleted by
-- the reseeder and by src/, SET NULL.
CREATE INDEX IF NOT EXISTS invoice_line_items_subscription_id_idx ON public.invoice_line_items (subscription_id);

-- CASCADE from properties, which src/ deletes. Also the read key behind the
-- services list on the property drawer.
CREATE INDEX IF NOT EXISTS idx_subs_property ON public.subscriptions (property_id);
CREATE INDEX IF NOT EXISTS client_notes_property_idx ON public.client_notes (property_id);

-- CASCADE from clients and from organizations. This table answers 4,015
-- sequential scans against 180 index scans today, which is the clearest
-- read-side signal in the whole set.
CREATE INDEX IF NOT EXISTS idx_waste_stations_client ON public.waste_stations (client_id);
CREATE INDEX IF NOT EXISTS idx_waste_stations_org ON public.waste_stations (organization_id);

-- CASCADE from clients; currently buried at position 2 of the
-- (organization_id, client_id, status) index.
CREATE INDEX IF NOT EXISTS addon_charges_client_id_idx ON public.addon_charges (client_id);

-- Unbounded, CASCADE from organizations, and the "Collected MTD" figure the
-- dashboard computes filters organization_id with no index to do it on.
CREATE INDEX IF NOT EXISTS payments_organization_id_idx ON public.payments (organization_id);

DO $post$
DECLARE
  _unindexed int;
  _r record;
  _invalid text[];
BEGIN
  -- Each index exists, is named as intended, sits on the intended table, and
  -- LEADS on the FK column — a wider index in the wrong order would satisfy a
  -- name check and none of the purpose.
  FOR _r IN
    SELECT * FROM (VALUES
      ('visits','property_id','idx_visits_property'),
      ('visits','zone_id','idx_visits_zone'),
      ('credit_ledger','visit_id','credit_ledger_visit_idx'),
      ('credit_ledger','invoice_id','credit_ledger_invoice_idx'),
      ('station_service_logs','waste_station_id','idx_station_logs_station'),
      ('station_service_logs','organization_id','idx_station_logs_org'),
      ('messages','visit_id','messages_visit_id_idx'),
      ('qc_tickets','visit_id','qc_tickets_visit_idx'),
      ('invoice_line_items','subscription_id','invoice_line_items_subscription_id_idx'),
      ('subscriptions','property_id','idx_subs_property'),
      ('client_notes','property_id','client_notes_property_idx'),
      ('waste_stations','client_id','idx_waste_stations_client'),
      ('waste_stations','organization_id','idx_waste_stations_org'),
      ('addon_charges','client_id','addon_charges_client_id_idx'),
      ('payments','organization_id','payments_organization_id_idx')
    ) AS t(tbl, col, idx)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
       WHERE i.indrelid = ('public.' || _r.tbl)::regclass
         AND ic.relname = _r.idx
         AND i.indisvalid
         AND i.indkey[0] = (SELECT attnum FROM pg_attribute
                             WHERE attrelid = ('public.' || _r.tbl)::regclass
                               AND attname = _r.col)
    ) THEN
      RAISE EXCEPTION '% is missing, invalid, or does not lead on %.%', _r.idx, _r.tbl, _r.col;
    END IF;
  END LOOP;

  -- 93 minus the fifteen. Asserting the total rather than only the fifteen is
  -- what catches an index accidentally covering a SIXTEENTH constraint, which
  -- would mean this file changed something it does not describe.
  SELECT count(*) INTO _unindexed
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
   WHERE c.contype = 'f' AND n.nspname = 'public'
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = c.conrelid
          AND (i.indkey::smallint[])[0:array_length(c.conkey,1)-1] = c.conkey);
  IF _unindexed <> 78 THEN
    RAISE WARNING 'expected 78 unindexed foreign keys after this migration, found %', _unindexed;
  END IF;

  -- Nothing in public may be left INVALID, which is the failure mode of a
  -- CONCURRENTLY build and the one thing a name check cannot see.
  SELECT coalesce(array_agg(ic.relname ORDER BY ic.relname), '{}') INTO _invalid
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
   WHERE n.nspname = 'public' AND NOT i.indisvalid;
  IF array_length(_invalid, 1) > 0 THEN
    RAISE EXCEPTION 'invalid indexes present in public: %', array_to_string(_invalid, ', ');
  END IF;
END
$post$;
