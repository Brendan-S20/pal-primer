-- BUG-10: placeholder station labels survived the renumber migration.
--
-- Stations render as "Station 1 · 0" and "Station 2 · 01". The NUMBERING is now
-- correct; what persists is the old placeholder text in the optional `label`
-- column, left behind when numbering moved to its own column.
--
-- The brief says labels are optional by design, and the APPLICATION already
-- agrees: stationDisplayName(number, label) returns "Station 1" for a null
-- label, StationMapPicker falls back to `Station ${n}`, and the stations panel
-- coalesces to "". The SCHEMA was the one place that disagreed — `label` was
-- NOT NULL, so clearing a placeholder was impossible and the junk text was
-- structurally stuck. (Found the hard way: the first version of this migration
-- failed on the not-null constraint.) So drop the constraint first, aligning
-- the column with the design its own readers already assume.
--
-- Creating a station still REQUIRES a real label — stations.functions.ts
-- validates min(1) plus isValidLabel(), which rejects placeholders outright.
-- Optional at rest, validated on entry: that is what stops new junk while
-- letting existing junk be removed.
--
-- Idempotent: the ALTER is a no-op once applied, and the UPDATE matches nothing
-- once the labels are NULL.
ALTER TABLE public.waste_stations
  ALTER COLUMN label DROP NOT NULL;

COMMENT ON COLUMN public.waste_stations.label IS
  'Optional human name for a station ("Back gate", "Pool house"). NULL means the station is identified by its number alone — stationDisplayName() renders "Station N". Creation still requires a non-placeholder label; NULL exists for stations whose pre-renumber placeholder was cleared.';

-- Deliberately narrow (guardrail 10.5 — never silently guess): clears ONLY
-- zero-prefixed numeric strings ('0', '01', '007'), the exact signature of the
-- pre-renumber placeholder, which cannot be a label a human chose to type. A
-- label like '3' is left alone — redundant next to a station number, but
-- possibly intended, and this migration is not the place to decide that.
UPDATE public.waste_stations
SET label = NULL
WHERE label IS NOT NULL
  AND btrim(label) ~ '^0+[0-9]*$';
