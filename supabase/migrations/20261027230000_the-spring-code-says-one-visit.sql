-- The demo's spring code says what it does (#433).
--
-- seed_demo_org writes DEMOSPRING as a 15% percent code with the column
-- default applies_to = 'first_visit', and the description "15% off your next
-- 3 visits". Settings > Promotions computes the rule from the columns and
-- printed "15% off one visit" directly above "15% off your next 3 visits".
-- #469 hid the stale description in the UI (src/lib/promo-copy.ts); this
-- stops the seed writing it and rewrites the rows that still hold it, so the
-- words and the rule are the same thing wherever the row is read.
--
-- Spliced by name against the body 20261004010000 left, the same way that
-- file and the two before it were: a full CREATE OR REPLACE would restate
-- ~600 lines to change one string. Already spliced is a no-op; a body that
-- no longer has the line raises rather than silently doing nothing.
--
-- Replays into an empty database: the function exists (it is created and
-- spliced earlier in the sequence), and the UPDATE finds no rows. The check
-- reads the body it leaves, not rows.

DO $splice$
DECLARE
  _def text;
  _new text;
BEGIN
  _def := pg_get_functiondef('public.seed_demo_org(uuid)'::regprocedure);
  IF strpos(_def, '''15% off a new client''''s first visit''') > 0
     AND strpos(_def, 'next 3 visits') = 0 THEN
    RETURN;  -- already spliced
  END IF;

  _new := replace(_def,
    $o$(_org_id, 'DEMOSPRING',  'percent', NULL, 15,   '15% off your next 3 visits', true)$o$,
    $n$(_org_id, 'DEMOSPRING',  'percent', NULL, 15,   '15% off a new client''s first visit', true)$n$);
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer writes DEMOSPRING the way this splice expects; re-cut it against the current body.';
  END IF;

  EXECUTE _new;
END
$splice$;

REVOKE ALL ON FUNCTION public.seed_demo_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_org(uuid) TO authenticated, service_role;

-- Rows a seed already wrote, and only while they are still the seed's: a
-- description an owner typed, or a code whose rule was changed, is theirs.
UPDATE public.promo_codes
   SET description = '15% off a new client''s first visit'
 WHERE code = 'DEMOSPRING'
   AND discount_type = 'percent'
   AND discount_percent = 15
   AND applies_to = 'first_visit'
   AND description IN ('15% off your next 3 visits', '15% off next 3 visits');

DO $check$
DECLARE
  _seed text;
BEGIN
  SELECT prosrc INTO _seed FROM pg_proc WHERE oid = 'public.seed_demo_org(uuid)'::regprocedure;
  IF _seed ~* 'next 3 visits' THEN
    RAISE EXCEPTION 'seed_demo_org still describes DEMOSPRING as three visits';
  END IF;
  IF strpos(_seed, '''15% off a new client''''s first visit''') = 0 THEN
    RAISE EXCEPTION 'seed_demo_org does not write the DEMOSPRING description this file set';
  END IF;
  IF has_function_privilege('anon', 'public.seed_demo_org(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can reseed an organization';
  END IF;
END
$check$;
