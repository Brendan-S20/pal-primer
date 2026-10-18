-- The plan sentences follow the Oct 9 catalog (#491; owner confirmed the Oct 9
-- numbers on 2026-10-17).
--
-- 20261009150000 moved Launch, Growth and Scale to 1/5/20 included people and
-- $15 per extra person, but it never rewrote `description`. So each row still
-- carried the July sentence from 20260710140100 ("Includes 10 employees;
-- $10/mo per additional active employee"), and the platform Plans table shows
-- it to staff. This file replaces the three sentences with houndstack.com's
-- own wording (src/pages/pricing.astro), with "to" in place of the en dash.
--
-- Enterprise is priced by contract, so its price_per_seat_cents goes to NULL.
-- At 1000 the platform Plans table showed "$10/employee/month" for it, and
-- platform-metrics added $10 per active seat to an Enterprise tenant's MRR
-- (its included_seats is NULL, read as 0). It has no Stripe seat price, so
-- seat sync already skipped it.
--
-- Nothing else changes. The inactive legacy rows (free, puppy, fetch, scoop,
-- haul, pack, kennel) are not touched. 20260710140100 and 20260803050000 are
-- left as they ran; this file supersedes their text.
--
-- Safe to run twice: each UPDATE sets a fixed value by slug.
-- Replays into an empty database: no rows, so the UPDATEs touch nothing and
-- the check warns once per missing plan.

UPDATE public.platform_plans
   SET description = v.description,
       updated_at = now()
  FROM (VALUES
          ('launch', '$79 per month for teams of 1 to 3 people, with 1 person included. Extra people are $15 per month each, up to 3 people.'),
          ('growth', '$199 per month for teams of 4 to 15 people, with 5 people included. Extra people are $15 per month each, up to 15 people.'),
          ('scale', '$449 per month for teams of 16 or more people, with 20 included. Extra people are $15 per month each.')
       ) AS v(slug, description)
 WHERE platform_plans.slug = v.slug
   AND platform_plans.description IS DISTINCT FROM v.description;

UPDATE public.platform_plans
   SET price_per_seat_cents = NULL,
       updated_at = now()
 WHERE slug = 'enterprise'
   AND price_per_seat_cents IS NOT NULL;

DO $check$
DECLARE
  _p record;
  _seen int := 0;
BEGIN
  -- The rows, where they exist. A fresh build has none; that is a warning.
  FOR _p IN
    SELECT v.slug AS want_slug, v.description AS want_description,
           p.id, p.description
      FROM (VALUES
              ('launch', '$79 per month for teams of 1 to 3 people, with 1 person included. Extra people are $15 per month each, up to 3 people.'),
              ('growth', '$199 per month for teams of 4 to 15 people, with 5 people included. Extra people are $15 per month each, up to 15 people.'),
              ('scale', '$449 per month for teams of 16 or more people, with 20 included. Extra people are $15 per month each.')
           ) AS v(slug, description)
      LEFT JOIN public.platform_plans p ON p.slug = v.slug
  LOOP
    IF _p.id IS NULL THEN
      RAISE WARNING 'no % plan on this database; nothing to update for it', _p.want_slug;
      CONTINUE;
    END IF;
    _seen := _seen + 1;
    IF _p.description ~ 'employees;' OR _p.description ~ '\$10/' THEN
      RAISE EXCEPTION 'plan % still carries the July sentence: %', _p.want_slug, _p.description;
    END IF;
    IF _p.description IS DISTINCT FROM _p.want_description THEN
      RAISE EXCEPTION 'plan % description is not the Oct 9 sentence: %', _p.want_slug, _p.description;
    END IF;
  END LOOP;
  RAISE NOTICE 'plan sentences updated: % of 3 present', _seen;

  SELECT id, price_per_seat_cents INTO _p
    FROM public.platform_plans WHERE slug = 'enterprise';
  IF NOT FOUND THEN
    RAISE WARNING 'no enterprise plan on this database; nothing to update for it';
  ELSIF _p.price_per_seat_cents IS NOT NULL THEN
    RAISE EXCEPTION 'enterprise price_per_seat_cents is %, expected NULL', _p.price_per_seat_cents;
  END IF;
END
$check$;
