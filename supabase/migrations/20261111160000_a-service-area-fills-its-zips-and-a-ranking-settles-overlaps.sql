-- #858: service areas fill their ZIPs on save, and a ranking settles overlaps.
--
-- Brendan, 2026-11-10 1:58 PM ET: "have it auto fill, and then there should
-- be a ranking system for priority; sometimes the zip codes are going to
-- automatically overlap and there's too much steps to walkthrough and
-- manually fix that." And at 2:01 PM, the two decisions this file carries
-- out: "Rank existing areas newest first", and "Yes, warn the owner" (the
-- warning is in the app, src/lib/zone-ranking.ts; nothing here).
--
-- Two things change in the database, and the rule that reads them does not:
--
--   1. `zones.zip_fill_pending_since`. A save whose ZIP lookup failed still
--      saves (an area is never refused for a Census hiccup) and is marked
--      here, so the list says "ZIPs pending" and the next read of the list
--      runs the fill again (zones.functions.ts, retryPendingZipFills). NULL
--      for every area that has what the shape holds.
--
--   2. Every business's existing areas are ranked newest first. The rank IS
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
-- rows. Running it twice changes nothing: the second UPDATE finds every
-- priority already equal to its rank. Checks at the end: what this file
-- ESTABLISHES is raised on (no two areas of one business share a priority);
-- what it found is only reported.

ALTER TABLE public.zones ADD COLUMN IF NOT EXISTS zip_fill_pending_since timestamptz;

COMMENT ON COLUMN public.zones.zip_fill_pending_since IS
  'Set when a save could not look up the ZIPs inside the drawn area (#858). The next read of the zone list runs the fill again and clears it.';

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
  RAISE WARNING '[20261111160000] ranked the areas of % business(es) newest first; % row(s) changed',
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
    RAISE EXCEPTION '[20261111160000] % business/priority pair(s) are still shared by two or more areas', _dupes;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'zones'
       AND column_name = 'zip_fill_pending_since' AND data_type = 'timestamp with time zone'
  ) INTO _col;
  IF NOT _col THEN
    RAISE EXCEPTION '[20261111160000] zones.zip_fill_pending_since is missing or not timestamptz';
  END IF;
END
$check$;
