-- The receptionist add-on says who books the visit (#537).
--
-- Plan & billing read: "Answers your clients' texts about pricing and
-- availability from your own price list and FAQ, and books visits into your
-- calendar." houndstack.com/pricing read: "Will answer client texts with your
-- real prices and your FAQ, and pass the lead to the office to book." An owner
-- reading the app expected every text to end in a booked visit; one reading
-- the site expected none to.
--
-- Neither is what the receptionist does (src/lib/receptionist-booking.ts,
-- booksStraightIn): it books the visit only when the owner turned on "Book
-- requests automatically" AND the service has a price; otherwise the request
-- goes to the office to confirm. This description says exactly that, in the
-- owner's one sentence (product review on #562), future tense while the
-- add-on is coming soon. The site's add-ons list and the marketing claims
-- take the same sentence. It does not claim it always books, or that it
-- offers times.
--
-- The "Coming soon." prefix stays: settings.billing.tsx strips it next to the
-- badge, and 20261009210000's check (coming soon, carrier registration, no
-- "day and night") still holds for this text.
--
-- Replays into an empty database: the row is inserted by 20260714100000, and
-- a database without it warns rather than fails. The check asserts only what
-- this file establishes.

UPDATE public.platform_addons
   SET description =
         'Coming soon. Will answer your clients'' texts about pricing and '
         'availability from your own price list and FAQ. It will book the '
         'visit if you turn on Book requests automatically and the service '
         'has a price; otherwise it sends the request to your office. Texting '
         'starts once carrier registration clears.',
       updated_at = now()
 WHERE slug = 'ai-receptionist';

DO $check$
DECLARE
  _status text;
  _d text;
BEGIN
  SELECT status, description INTO _status, _d
    FROM public.platform_addons
   WHERE slug = 'ai-receptionist';

  IF NOT FOUND THEN
    RAISE WARNING 'no ai-receptionist add-on on this database; no description was changed';
    RETURN;
  END IF;

  IF _d ~* 'books visits into your calendar' THEN
    RAISE EXCEPTION 'the receptionist add-on still promises to book every visit';
  END IF;
  IF _d !~* 'Book requests automatically and the service has a price'
     OR _d !~* 'otherwise it sends the request to your office' THEN
    RAISE EXCEPTION 'the receptionist add-on does not say when the office books';
  END IF;
  IF _status = 'coming_soon' AND _d !~* '^Coming soon\. Will ' THEN
    RAISE EXCEPTION 'the receptionist add-on is coming soon but its copy is not in the future tense';
  END IF;
  IF _d ~ '—' THEN
    RAISE EXCEPTION 'the receptionist add-on copy has an em dash';
  END IF;
END
$check$;
