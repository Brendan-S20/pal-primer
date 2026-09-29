-- The gate was latched and nobody could see it.
--
-- Found 2026-09-27 by the market research pass. The complaint that ends a
-- pet-waste account is not a missed pile, it is a dog out of the yard, and
-- the first question after one is "did your tech close the gate?". Operators
-- answer it with a photo of the latched gate on every visit, and customers
-- are told to expect one. Here a tech could take the photo, but only as
-- 'before', 'completion' or 'issue', so it arrived in the customer's email
-- (if at all) as one more "After" picture, and nothing afterwards could find
-- the gate photo for a given visit to answer the question.
--
-- 1. visit_photos accepts kind 'gate'. The constraint is swapped rather than
--    added to, keeping the three kinds 20260903170000 established, and
--    validated so it constrains existing rows too.
--
-- 2. A gate photo does NOT satisfy require_completion_photo. complete_visit
--    and confirm_open_visit look for kind = 'completion' and are left alone:
--    a latched gate proves the yard was closed, not that it was cleaned.
--
-- Replays into an empty database: one constraint swap. The DO block asserts
-- only what this file establishes.

ALTER TABLE public.visit_photos
  DROP CONSTRAINT IF EXISTS visit_photos_kind_is_one_the_app_writes;
ALTER TABLE public.visit_photos
  ADD CONSTRAINT visit_photos_kind_is_one_the_app_writes
  CHECK (kind IN ('completion', 'before', 'issue', 'gate')) NOT VALID;
ALTER TABLE public.visit_photos VALIDATE CONSTRAINT visit_photos_kind_is_one_the_app_writes;

DO $check$
DECLARE _def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO _def
    FROM pg_constraint
   WHERE conrelid = 'public.visit_photos'::regclass
     AND conname = 'visit_photos_kind_is_one_the_app_writes'
     AND convalidated;
  IF _def IS NULL THEN
    RAISE EXCEPTION 'the kind constraint is missing or was left NOT VALID';
  END IF;
  IF _def !~ '''gate''' THEN
    RAISE EXCEPTION 'visit_photos does not accept a gate photo: %', _def;
  END IF;
  IF _def !~ '''completion''' OR _def !~ '''before''' OR _def !~ '''issue''' THEN
    RAISE EXCEPTION 'the swap dropped a kind that was already allowed: %', _def;
  END IF;
END
$check$;
