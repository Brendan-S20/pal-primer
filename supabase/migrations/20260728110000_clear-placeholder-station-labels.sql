-- BUG-10: placeholder station labels survived the renumber migration.
--
-- Stations render as "Station 1 · 0" and "Station 2 · 01". The NUMBERING is now
-- correct; what persists is the old placeholder text in the optional `label`
-- column, left behind when numbering moved to its own column. Labels are
-- optional by design, so the fix is to clear the placeholders rather than
-- invent replacements.
--
-- Deliberately narrow (guardrail 10.5 — never silently guess): this clears ONLY
-- zero-prefixed numeric strings ('0', '01', '007'), which is the exact
-- signature of the pre-renumber placeholder and cannot be a label a human chose
-- to type. A label like '3' is left alone — redundant next to a station number,
-- but a person may have meant it, and this migration is not the place to decide
-- that. Verified against the live database before writing: exactly two rows
-- match, the two in the finding.
--
-- Idempotent: re-running matches nothing once the labels are NULL.
UPDATE public.waste_stations
SET label = NULL
WHERE label IS NOT NULL
  AND btrim(label) ~ '^0+[0-9]*$';
