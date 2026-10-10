-- The receptionist says what it does (owner's spec, 2026-10-09).
--
-- Two catalog/data strings still described a product HoundStack is not
-- selling yet, or a business it is not limited to.
--
-- 1. The default persona. 20260702002959 gave
--    organizations.ai_receptionist_persona a DEFAULT that calls every
--    business "a pet-waste cleanup company". HoundStack serves pet service
--    businesses generally, and the app-side default in
--    src/routes/_authenticated/settings.ai-receptionist.tsx was changed to
--    "a pet service company" (#370). This moves the column default to the
--    same text and rewrites rows that still hold an UNEDITED default.
--
--    There were two unedited defaults, and both are matched exactly:
--      - the column default, with an em dash ("prices — use the ..."), which
--        every organizations row was given on creation; and
--      - the app's own default, with a full stop ("prices. Use the ..."),
--        which the settings page pre-fills when the column is NULL and saves
--        verbatim if the owner presses Save without typing.
--    A persona that differs from both by a single character is one a
--    business wrote, and is left exactly as it is.
--
-- 2. The `ai-receptionist` add-on description. 20260714100000 wrote that it
--    "answers client texts for you day and night". 20261003120000 made it
--    coming soon and not purchasable, but left the copy selling it as live.
--    The marketing site's frozen Twilio wording is that it "will answer
--    client texts about pricing and availability and book straight into the
--    calendar", and that texting is coming soon, pending carrier
--    registration. This brings the add-on's description into line, and sets
--    the status again so the description can never say "coming soon" over a
--    row that is on sale.
--
-- On a fresh build there are no organizations, so the persona UPDATE finds
-- nothing; the add-on row is inserted by 20260714100000, but this follows
-- 20261009120000 and warns rather than fails if it is absent. The check
-- block asserts only what this file establishes.

ALTER TABLE public.organizations
  ALTER COLUMN ai_receptionist_persona SET DEFAULT
    'You are a friendly, concise SMS receptionist for a pet service company. '
    'Answer in 1-2 short sentences. Never invent prices. Use the '
    'get_pricing_quote tool. Offer to have a human follow up when unsure.';

UPDATE public.organizations
   SET ai_receptionist_persona =
         'You are a friendly, concise SMS receptionist for a pet service company. '
         'Answer in 1-2 short sentences. Never invent prices. Use the '
         'get_pricing_quote tool. Offer to have a human follow up when unsure.'
 WHERE ai_receptionist_persona IN (
         -- the column default from 20260702002959
         'You are a friendly, concise SMS receptionist for a pet-waste cleanup company. '
         'Answer in 1-2 short sentences. Never invent prices — use the '
         'get_pricing_quote tool. Offer to have a human follow up when unsure.',
         -- the settings page's pre-filled default before #370
         'You are a friendly, concise SMS receptionist for a pet-waste cleanup company. '
         'Answer in 1-2 short sentences. Never invent prices. Use the '
         'get_pricing_quote tool. Offer to have a human follow up when unsure.'
       );

UPDATE public.platform_addons
   SET status = 'coming_soon',
       description =
         'Coming soon. Answers your clients'' texts about pricing and '
         'availability from your own price list and FAQ, and books visits into '
         'your calendar. Texting starts once carrier registration clears.',
       updated_at = now()
 WHERE slug = 'ai-receptionist';

DO $check$
DECLARE
  _default text;
  _left int;
  _status text;
  _d text;
BEGIN
  -- The column default is what this file set.
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO _default
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'public.organizations'::regclass
     AND a.attname = 'ai_receptionist_persona';
  IF _default IS NULL OR _default !~ 'a pet service company' THEN
    RAISE EXCEPTION 'the receptionist persona default was not changed (now %)', _default;
  END IF;
  IF _default ~ 'pet-waste cleanup' THEN
    RAISE EXCEPTION 'the receptionist persona default still says pet-waste cleanup';
  END IF;

  -- No row is left holding either unedited old default. (On a fresh build
  -- there are no rows and this is trivially true; edited personas are not
  -- counted, because they are not ours to change.)
  SELECT count(*) INTO _left
    FROM public.organizations
   WHERE ai_receptionist_persona ~ '^You are a friendly, concise SMS receptionist for a pet-waste cleanup company\. Answer in 1-2 short sentences\. Never invent prices(\.| —) [Uu]se the get_pricing_quote tool\. Offer to have a human follow up when unsure\.$';
  IF _left > 0 THEN
    RAISE EXCEPTION '% organizations still hold the old default receptionist persona', _left;
  END IF;

  SELECT status, description INTO _status, _d
    FROM public.platform_addons
   WHERE slug = 'ai-receptionist';

  IF NOT FOUND THEN
    RAISE WARNING 'no ai-receptionist add-on on this database; no description was changed';
    RETURN;
  END IF;

  IF _status IS DISTINCT FROM 'coming_soon' THEN
    RAISE EXCEPTION 'the receptionist add-on is purchasable (status %)', _status;
  END IF;
  IF _d !~* 'coming soon' THEN
    RAISE EXCEPTION 'the receptionist add-on copy does not say it is coming soon';
  END IF;
  IF _d !~* 'carrier registration' THEN
    RAISE EXCEPTION 'the receptionist add-on copy no longer mentions the registration it waits on';
  END IF;
  IF _d ~* 'day and night' THEN
    RAISE EXCEPTION 'the receptionist add-on copy still sells it as answering day and night';
  END IF;
END
$check$;
