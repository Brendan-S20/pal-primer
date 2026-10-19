-- A US business reads its stops in miles (#496).
--
-- The board card and the visit drawer printed `travel_km` as "1.6 km" to a
-- business in Michigan. Distances stay stored in kilometres; what was missing
-- is any record of which country a business is in, so the app had nothing to
-- choose a display unit from. This adds it.
--
-- 1. organizations.country: ISO 3166-1 alpha-2, two uppercase letters, NULL
--    when unknown. Set in Settings > Business, and by the setup guide when the
--    business address it saves ends in a US state and ZIP. The app reads it
--    through orgDistanceUnit (src/lib/distance-unit.ts): US and the US
--    territories read miles, every other known country reads kilometres, and
--    NULL falls back to the browser's region and then to the currency.
--
-- 2. A backfill of existing businesses, only where country IS NULL, in order
--    of how much each signal says:
--
--    a. The contact address ends in a US state or territory code and a ZIP,
--       optionally followed by "USA" / "US" / "United States": 'US', or the
--       territory's own code for PR, GU, VI, AS, MP. The same pattern as
--       countryFromAddress in src/lib/distance-unit.ts.
--    b. The contact address ends in a Canadian province code and postal
--       code (A1A 1A1), optionally followed by "Canada": 'CA'.
--    c. currency = 'usd' and the timezone is a US zone: 'US'. A list of US
--       zones rather than "anything under America/", because America/ is
--       also Toronto, Mexico City and Bogota.
--    c2. currency = 'usd' and America/Puerto_Rico or Pacific/Guam: 'PR' or
--       'GU', the territory's own code, as in (a).
--    d. currency = 'cad' and the timezone is a Canadian zone: 'CA'.
--
--    Anything else stays NULL, which the app treats as "ask the browser".
--
-- Replays into an empty database: one column, one check, and updates that
-- match no rows on a fresh build. The final block asserts only what this file
-- establishes; the backfill counts are reported, not asserted, because they
-- describe whichever database this runs on.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS country text;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_country_iso2;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_country_iso2
  CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

COMMENT ON COLUMN public.organizations.country IS
  'ISO 3166-1 alpha-2 country of the business, NULL when unknown. Decides the distance unit the app displays (miles for US and US territories, km elsewhere); stored distances stay in km. Migration 20261018120000.';

-- a. A US state or territory and a ZIP at the end of the address.
UPDATE public.organizations
   SET country = CASE
         WHEN substring(contact_address FROM
                '\m(PR|GU|VI|AS|MP)\s+\d{5}(-\d{4})?\s*(,?\s*(USA|US|United States|United States of America)\.?)?\s*$')
              IS NOT NULL
           THEN substring(contact_address FROM
                '\m(PR|GU|VI|AS|MP)\s+\d{5}(-\d{4})?\s*(,?\s*(USA|US|United States|United States of America)\.?)?\s*$')
         ELSE 'US'
       END
 WHERE country IS NULL
   AND contact_address ~ '\m(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR|GU|VI|AS|MP)\s+\d{5}(-\d{4})?\s*(,?\s*(USA|US|United States|United States of America)\.?)?\s*$';

-- b. A Canadian province and postal code at the end of the address.
UPDATE public.organizations
   SET country = 'CA'
 WHERE country IS NULL
   AND contact_address ~* '\m(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\s*(,?\s*Canada\.?)?\s*$';

-- c. Dollars and a US clock.
UPDATE public.organizations
   SET country = 'US'
 WHERE country IS NULL
   AND lower(currency) = 'usd'
   AND (
     timezone IN (
       'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
       'America/Los_Angeles', 'America/Anchorage', 'America/Detroit', 'America/Boise',
       'America/Juneau', 'America/Sitka', 'America/Nome', 'America/Yakutat',
       'America/Metlakatla', 'America/Adak', 'America/Menominee',
       'America/Indianapolis', 'America/Louisville', 'America/Fort_Wayne',
       'US/Eastern', 'US/Central', 'US/Mountain', 'US/Pacific', 'US/Arizona',
       'US/Alaska', 'US/Hawaii', 'US/Aleutian', 'US/Michigan', 'Pacific/Honolulu'
     )
     OR timezone LIKE 'America/Indiana/%'
     OR timezone LIKE 'America/Kentucky/%'
     OR timezone LIKE 'America/North_Dakota/%'
   );

-- c2. Dollars and a territory's clock: the territory's own code, as in (a).
UPDATE public.organizations
   SET country = CASE timezone
         WHEN 'America/Puerto_Rico' THEN 'PR'
         WHEN 'Pacific/Guam' THEN 'GU'
       END
 WHERE country IS NULL
   AND lower(currency) = 'usd'
   AND timezone IN ('America/Puerto_Rico', 'Pacific/Guam');

-- d. Canadian dollars and a Canadian clock.
UPDATE public.organizations
   SET country = 'CA'
 WHERE country IS NULL
   AND lower(currency) = 'cad'
   AND timezone IN (
     'America/Toronto', 'America/Montreal', 'America/Vancouver', 'America/Edmonton',
     'America/Winnipeg', 'America/Regina', 'America/Swift_Current', 'America/Halifax',
     'America/Moncton', 'America/Glace_Bay', 'America/Goose_Bay', 'America/St_Johns',
     'America/Whitehorse', 'America/Dawson', 'America/Dawson_Creek', 'America/Fort_Nelson',
     'America/Creston', 'America/Yellowknife', 'America/Inuvik', 'America/Cambridge_Bay',
     'America/Iqaluit', 'America/Rankin_Inlet', 'America/Resolute', 'America/Atikokan',
     'America/Blanc-Sablon', 'America/Nipigon', 'America/Thunder_Bay',
     'America/Rainy_River', 'America/Pangnirtung',
     'Canada/Eastern', 'Canada/Central', 'Canada/Mountain', 'Canada/Pacific',
     'Canada/Atlantic', 'Canada/Newfoundland', 'Canada/Saskatchewan', 'Canada/Yukon'
   );

-- What this file establishes.
DO $check$
DECLARE
  _n_us int;
  _n_other int;
  _n_null int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'organizations'
       AND c.column_name = 'country' AND c.data_type = 'text' AND c.is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'organizations.country is missing or is not a nullable text column';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.organizations'::regclass
       AND conname = 'organizations_country_iso2'
       AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'organizations_country_iso2 check is missing';
  END IF;

  -- Reported, not asserted: these describe the database, not this file. On a
  -- fresh build all three are zero, and that is the expected answer.
  SELECT count(*) FILTER (WHERE country = 'US'),
         count(*) FILTER (WHERE country IS NOT NULL AND country <> 'US'),
         count(*) FILTER (WHERE country IS NULL)
    INTO _n_us, _n_other, _n_null
    FROM public.organizations;
  RAISE NOTICE 'organizations.country after backfill: % US, % other, % unknown (NULL)',
    _n_us, _n_other, _n_null;
END
$check$;
