-- A guarantee nobody offered.
--
-- 20260928110000 gave every organization a 48-hour re-clean window, so the
-- moment it was applied, every existing business's customers were offered a
-- free re-clean in their portal. Some of those businesses do not have that
-- guarantee. A promise made to customers is the owner's to make.
--
-- The same rule as the day-before reminder (20260928040000): businesses that
-- existed when the feature arrived start with it off and turn it on in
-- Settings -> Preferences -> "Re-clean guarantee"; businesses created from
-- now on keep the 48-hour default.
--
-- Replays into an empty database: an UPDATE that touches no rows when there
-- are none. Nothing to assert beyond the column the earlier file created.

UPDATE public.organizations SET reclean_window_hours = 0;
