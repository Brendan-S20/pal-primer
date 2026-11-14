-- #858: service areas fill their ZIPs on save, and a ranking settles overlaps.
--
-- Brendan, 2026-11-10 1:58 PM ET: "have it auto fill, and then there should
-- be a ranking system for priority; sometimes the zip codes are going to
-- automatically overlap and there's too much steps to walkthrough and
-- manually fix that." And at 2:01 PM, the two decisions this file carries
-- out: "Rank existing areas newest first", and "Yes, warn the owner" (the
-- warning is in the app, src/lib/zone-ranking.ts; nothing here).
--
-- Three things change in the database, and the rule that reads them does not:
--
--   1. `zones.zip_fill_pending_since` and `zip_fill_last_tried_at`. A save
--      whose ZIP lookup failed still saves (an area is never refused for a
--      Census hiccup) and is marked pending, so the list says "ZIPs pending"
--      and a later read of the list by someone who may edit zones runs the
--      fill again, at most once every ten minutes per area
--      (zones.functions.ts, retryPendingZipFills). Both NULL for every area
--      that has what the shape holds.
--
--   2. `reorder_zones(_org_id, _ids)`: the owner's reorder, as ONE statement.
--      One UPDATE over the whole list, so the order lands whole or not at
--      all; two people reordering at once serialise on the rows and the last
--      one wins wholesale, never half each. SECURITY INVOKER: row-level
--      security decides who may write, exactly as a plain UPDATE would, and
--      the function refuses a list that is not the business's complete set.
--
--   3. Every business's existing areas are ranked newest first. The rank IS
--      `zones.priority`, the overlap tie-breaker since 20260716201000 (higher
--      wins among zones that match at the same level, in zone-match.ts and in
--      public_quote). Within each business the newest area gets the highest
--      number and the oldest gets 1, so rank 1 in the app -- the top of the
--      list -- is the newest. An area created after this goes under all of
--      them (createZone writes one below the business's lowest), and the
--      owner reorders from the Zones page (reorderZones), which renumbers the
--      business densely. public_quote, the matcher, the redetect and the
--      coverage check keep reading `priority` exactly as they do today;
--      that is the point of storing the rank there.
--
--      Any priority typed into the old drawer field is replaced by this
--      order. Brendan's decision names the order, and a typed number next to
--      a dense ranking is a tie waiting to happen.
--
-- Replays into an empty database: an ALTER and an UPDATE that touches no
-- rows. A second run BEFORE any owner has reordered changes nothing: the
-- UPDATE finds every priority already equal to its rank. After an owner has
-- reordered, a replay would put the newest-first order back, which is why
-- this runs once, under the ledger, and never as a repair. Checks at the
-- end: what this file
-- ESTABLISHES is raised on (no two areas of one business share a priority);
-- what it found is only reported.

ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS zip_fill_pending_since timestamptz;

COMMENT ON COLUMN public.zones.zip_fill_pending_since IS
  'Set when a save could not look up the ZIPs inside the drawn area (#858). A later read of the zone list by a pricing manager runs the fill again and clears it.';

ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS zip_fill_last_tried_at timestamptz;

COMMENT ON COLUMN public.zones.zip_fill_last_tried_at IS
  'When the pending ZIP fill was last retried (#858): the list retries an area at most once every ten minutes.';

-- ── The reorder, as one statement ──────────────────────────────────────────
-- `_ids` is the business's areas top to bottom: the first gets the highest
-- priority (cardinality(_ids)) and the last gets 1. Refused unless the list
-- is exactly the business's set of areas, so a stale client cannot leave an
-- area unranked or rank one it does not own. Row-level security still
-- applies (SECURITY INVOKER): a caller who may not update zones changes no
-- rows, and the count check turns that silence into an error.
CREATE OR REPLACE FUNCTION public.reorder_zones(_org_id uuid, _ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  _expected integer;
  _distinct integer;
  _changed integer;
BEGIN
  IF _ids IS NULL OR cardinality(_ids) = 0 THEN
    RAISE EXCEPTION 'reorder_zones: no areas given';
  END IF;
  SELECT count(DISTINCT i) INTO _distinct FROM unnest(_ids) AS i;
  IF _distinct <> cardinality(_ids) THEN
    RAISE EXCEPTION 'reorder_zones: an area is listed twice';
  END IF;
  SELECT count(*) INTO _expected FROM public.zones z WHERE z.organization_id = _org_id;
  IF _expected <> cardinality(_ids)
     OR EXISTS (
       SELECT 1 FROM unnest(_ids) AS i
        WHERE NOT EXISTS (
          SELECT 1 FROM public.zones z WHERE z.id = i AND z.organization_id = _org_id))
  THEN
    RAISE EXCEPTION 'reorder_zones: the list is not this business''s areas';
  END IF;

  UPDATE public.zones z
     SET priority = cardinality(_ids) - o.ord::integer + 1
    FROM unnest(_ids) WITH ORDINALITY AS o(id, ord)
   WHERE z.id = o.id
     AND z.organization_id = _org_id;
  GET DIAGNOSTICS _changed = ROW_COUNT;
  IF _changed <> cardinality(_ids) THEN
    RAISE EXCEPTION 'reorder_zones: not allowed to reorder these areas';
  END IF;
  RETURN _changed;
END
$fn$;

REVOKE ALL ON FUNCTION public.reorder_zones(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_zones(uuid, uuid[]) TO authenticated, service_role;

COMMENT ON COLUMN public.zones.priority IS
  'The business''s ranking of its areas (#858): higher wins a ZIP two areas list, in zone-match.ts and public_quote. Written densely by reorderZones; a new area goes one below the lowest.';

-- ── Rank existing areas newest first, per business ─────────────────────────
-- row_number over created_at ascending: the oldest is 1, the newest is N, and
-- N is the top of the list. `id` breaks a tie on created_at so two areas
-- seeded in one statement get a definite order rather than a shared number.
DO $rank$
DECLARE
  _changed integer;
  _businesses integer;
BEGIN
  WITH ranked AS (
    SELECT z.id,
           row_number() OVER (
             PARTITION BY z.organization_id
             ORDER BY z.created_at ASC, z.id ASC
           )::integer AS rank_priority
      FROM public.zones z
  )
  UPDATE public.zones z
     SET priority = r.rank_priority
    FROM ranked r
   WHERE z.id = r.id
     AND z.priority IS DISTINCT FROM r.rank_priority;
  GET DIAGNOSTICS _changed = ROW_COUNT;
  SELECT count(DISTINCT organization_id) INTO _businesses FROM public.zones;
  -- A number measured from the database this ran on: reported, not asserted.
  RAISE WARNING '[20261112030000] ranked the areas of % business(es) newest first; % row(s) changed',
    _businesses, _changed;
END
$rank$;

-- ── What this file establishes ─────────────────────────────────────────────
DO $check$
DECLARE
  _dupes integer;
  _col boolean;
BEGIN
  SELECT count(*) INTO _dupes
    FROM (
      SELECT organization_id, priority
        FROM public.zones
       GROUP BY organization_id, priority
      HAVING count(*) > 1
    ) d;
  IF _dupes > 0 THEN
    RAISE EXCEPTION '[20261112030000] % business/priority pair(s) are still shared by two or more areas', _dupes;
  END IF;

  SELECT count(*) = 2 INTO _col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'zones'
     AND column_name IN ('zip_fill_pending_since', 'zip_fill_last_tried_at')
     AND data_type = 'timestamp with time zone';
  IF NOT _col THEN
    RAISE EXCEPTION '[20261112030000] zones.zip_fill_pending_since / zip_fill_last_tried_at are missing or not timestamptz';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'reorder_zones' AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION '[20261112030000] public.reorder_zones is missing or SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.reorder_zones(uuid, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION '[20261112030000] anon can execute reorder_zones';
  END IF;
END
$check$;
