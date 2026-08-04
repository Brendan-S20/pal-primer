-- The schedule was generated 14 days ahead, and topping it up was a button.
--
-- ── WHAT THAT MEANT ───────────────────────────────────────────────────────
--
-- `auto_generate_days_ahead` defaulted to 14, so the nightly job kept exactly
-- a fortnight of work on the books. Look at the calendar in week view and the
-- following month was empty — not "no work booked", but "not generated yet",
-- and nothing on screen distinguished those two. A dispatcher planning three
-- weeks out saw a blank grid for a fully-subscribed client base.
--
-- The remedy was a "Create visits from subscriptions, through <date>" control
-- on the routes screen. It worked, and it should never have been a thing a
-- human does: a recurring plan already says when its visits happen. Asking
-- someone to press a button to make the schedule exist is asking them to
-- remember to do the computer's job, and the failure mode is silent — an empty
-- calendar looks like a quiet month.
--
-- ── THE HORIZON ───────────────────────────────────────────────────────────
--
-- 90 days, rolling, regenerated nightly. Not unbounded: "indefinitely" as a
-- literal instruction would mean generating rows until the disk filled, and
-- every price or frequency change would have to rewrite all of them. A quarter
-- is long enough to plan and sell against, and about 13 rows per weekly client.
--
-- Orgs already carrying a deliberately different number are left alone — this
-- moves the ones still sitting on the old default, not anyone's considered
-- choice. (At the time of writing all three orgs are on 14, i.e. the default.)
--
-- Nothing here changes WHICH visits get made. `generate_visits_for_subscription`
-- already stops at a subscription's `ends_on` and skips non-active ones, so a
-- client set up not to repeat still does not repeat — it just no longer needs a
-- button pressed to find that out.

-- The existing CHECK capped this at 60, which is below the new default — so
-- the ceiling has to move before the default can. Raised to 365 rather than
-- removed: a year is the largest horizon that is ever a considered choice, and
-- an unbounded column is how someone types 36500 and generates a century of
-- visits. The floor stays at 1.
ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_auto_generate_days_ahead_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_auto_generate_days_ahead_check
  CHECK (auto_generate_days_ahead >= 1 AND auto_generate_days_ahead <= 365);

ALTER TABLE public.organizations
  ALTER COLUMN auto_generate_days_ahead SET DEFAULT 90;

UPDATE public.organizations
   SET auto_generate_days_ahead = 90
 WHERE auto_generate_days_ahead = 14;

-- Generation stays opt-out rather than opt-in (the column already defaults
-- true). Restated so the pair is visible in one place: a schedule that does
-- not fill itself is the defect above.
ALTER TABLE public.organizations
  ALTER COLUMN auto_generate_visits SET DEFAULT true;

COMMENT ON COLUMN public.organizations.auto_generate_days_ahead IS
  'How far ahead the nightly job keeps the schedule filled, in days. Default 90. Was 14, which left the calendar empty past a fortnight and needed a manual "generate" press to extend.';
