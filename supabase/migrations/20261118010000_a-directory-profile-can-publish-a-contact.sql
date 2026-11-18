-- A directory profile may publish a contact email and phone (pal-primer #969;
-- mypets PR #18, per-business Privacy Policy and Terms pages).
--
-- PROPOSED MIGRATION. File only: not applied to any live database by the
-- change that adds it. Brendan signs off before it reaches production.
--
-- WHY. mypets.services shows /{slug}/privacy and /{slug}/terms for each
-- business, and a carrier reviewing the texting registration expects a way to
-- reach the business. The owner chooses the contact to publish; it is never
-- the account email or phone, which stay private.
--
-- WHAT THIS ADDS, all of it additive:
--   * directory_profiles.public_email text, nullable: NULL or a trimmed,
--     basic address (one @, no spaces, a dotted
--     domain), at most 254 characters.
--   * directory_profiles.public_phone text, nullable: NULL or E.164
--     (+ and 8 to 15 digits, first digit not 0) or a digits-only number of 7
--     to 15 digits.
--   * directory_public_listings: the same two columns, added at the END
--     (CREATE OR REPLACE VIEW may only append), every other column kept by
--     name, type, position and expression. security_barrier and the grants
--     are unchanged. A column on directory_profiles is NOT readable by anon;
--     only the view carries it, and only for a PUBLISHED profile.
--
-- WHAT IT DOES NOT CHANGE. No data is rewritten: existing rows get NULL, so
-- the CHECKs validate nothing on existing data. The owner's write path (the
-- save function that sets tagline, highlights and the rest) is not touched
-- here; wiring a Settings field to these two columns is a separate change.
--
-- ROLLBACK: supabase/rollback/20261118010000_a-directory-profile-can-publish-a-contact.down.sql

ALTER TABLE public.directory_profiles ADD COLUMN IF NOT EXISTS public_email text;
ALTER TABLE public.directory_profiles ADD COLUMN IF NOT EXISTS public_phone text;

ALTER TABLE public.directory_profiles DROP CONSTRAINT IF EXISTS directory_profiles_public_email_check;
ALTER TABLE public.directory_profiles ADD CONSTRAINT directory_profiles_public_email_check
  CHECK (public_email IS NULL
         OR (char_length(public_email) <= 254
             AND public_email ~ '^[^@[:space:]]+@[^@[:space:].]+(\.[^@[:space:].]+)+$'));
ALTER TABLE public.directory_profiles DROP CONSTRAINT IF EXISTS directory_profiles_public_phone_check;
ALTER TABLE public.directory_profiles ADD CONSTRAINT directory_profiles_public_phone_check
  CHECK (public_phone IS NULL
         OR public_phone ~ '^(\+[1-9][0-9]{7,14}|[0-9]{7,15})$');

COMMENT ON COLUMN public.directory_profiles.public_email IS
  'The contact email the owner chooses to publish on the listing (#969). NULL = none. Never the account email.';
COMMENT ON COLUMN public.directory_profiles.public_phone IS
  'The contact phone the owner chooses to publish on the listing (#969): E.164 (+15551234567) or digits only. NULL = none. Never the account phone.';

-- ── The public view, two columns longer ─────────────────────────────────────
-- Same 16 columns, same expressions; public_email and public_phone appended.
CREATE OR REPLACE VIEW public.directory_public_listings
  WITH (security_barrier = true)
AS
  SELECT p.slug,
         p.display_name,
         CASE WHEN p.show_logo THEN o.logo_url END AS logo_url,
         p.bio,
         p.service_lines,
         p.coverage_zips,
         p.coverage_cities,
         COALESCE(bk.services, '[]'::jsonb) AS services,
         p.published_at,
         p.tagline,
         p.highlights,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'name', a.name,
                    'zips', to_jsonb(ARRAY(
                      SELECT z FROM unnest(a.zips) AS u(z)
                       WHERE z = ANY (p.coverage_zips) ORDER BY z)))
                  ORDER BY a.position, a.name)
             FROM public.directory_profile_areas a
            WHERE a.organization_id = p.organization_id
              AND a.zips && p.coverage_zips
         ), '[]'::jsonb) AS areas,
         COALESCE(bk.books_online, false) AS books_online,
         o.booking_policy_text AS booking_policy_text,
         CASE WHEN COALESCE(bk.books_online, false) THEN '/d/' || p.slug || '/book' END AS book_path,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'url', '/d/' || p.slug || '/photos/' || left(md5('directory-photo:' || ph.id::text), 16),
                    'alt', ph.alt,
                    'position', ph.position)
                  ORDER BY ph.position, ph.created_at)
             FROM public.directory_profile_photos ph
            WHERE ph.organization_id = p.organization_id
              AND ph.status = 'approved'
         ), '[]'::jsonb) AS photos,
         p.public_email,
         p.public_phone
    FROM public.directory_profiles p
    JOIN public.organizations o ON o.id = p.organization_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'label', b.label,
               'service_line', b.service_line,
               'price_from_cents', b.price_from_cents,
               'price_unit', b.price_unit,
               'booking_mode', b.booking_mode,
               'booking_key', b.booking_key,
               'package', CASE WHEN b.booking_mode = 'package' THEN b.pack END)
             ORDER BY b.position, b.label) AS services,
             bool_or(b.booking_mode <> 'request_only') AS books_online
        FROM (
          SELECT ds.label,
                 ds.service_line,
                 ds.price_from_cents,
                 ds.price_unit,
                 ds.position,
                 left(md5('directory-service:' || ds.service_id::text), 12) AS booking_key,
                 CASE
                   -- The business's three gates, every one of them on.
                   WHEN NOT (o.directory_booking_enabled
                             AND o.public_signup_enabled
                             AND o.stripe_connect_charges_enabled) THEN 'request_only'
                   -- The service as the booking link would list it.
                   WHEN sv.id IS NULL
                     OR NOT sv.active
                     OR NOT EXISTS (SELECT 1 FROM public.platform_service_lines l
                                     WHERE l.service_line = sv.service_line AND l.bookable)
                     OR NOT (sv.service_line = 'pet_waste' OR sv.base_price_cents IS NOT NULL)
                     THEN 'request_only'
                   -- Its own stored mode.
                   WHEN sv.public_booking_mode IN ('one_time', 'recurring') THEN sv.public_booking_mode
                   WHEN sv.public_booking_mode = 'package'
                    AND sv.service_line <> 'mobile_grooming'
                    AND pk.id IS NOT NULL THEN 'package'
                   ELSE 'request_only'
                 END AS booking_mode,
                 CASE WHEN pk.id IS NOT NULL THEN jsonb_build_object(
                   'name', pk.name,
                   'sessions_count', pk.sessions_count,
                   'price_cents', pk.price_cents) END AS pack
            FROM public.directory_profile_services ds
            LEFT JOIN public.services sv
              ON sv.id = ds.service_id AND sv.organization_id = ds.organization_id
            LEFT JOIN public.service_packages pk
              ON pk.id = sv.public_package_id
             AND pk.organization_id = sv.organization_id
             AND pk.service_id = sv.id
             AND pk.active
             AND pk.sessions_count > 0
             AND pk.price_cents > 0
           WHERE ds.organization_id = p.organization_id
        ) b
    ) bk ON true
   WHERE p.published
     AND o.deleted_at IS NULL;

COMMENT ON VIEW public.directory_public_listings IS
  'Every PUBLISHED directory profile of a live business, in the public shape only (slug, display_name, logo_url, bio, service_lines, coverage_zips, coverage_cities, services[label, service_line, price_from_cents, price_unit, booking_mode, booking_key, package{name, sessions_count, price_cents}], published_at, tagline, highlights, areas[name, zips], books_online, booking_policy_text, book_path, photos[url, alt, position], public_email, public_phone). booking_mode is request_only unless the owner''s directory switch, public signup and Stripe charges are all on and the service''s own mode can be sold. photos are APPROVED photos only; url is a HoundStack path (/d/{slug}/photos/{opaque key}), never a storage path. public_email and public_phone are the contact the owner chose to publish, or NULL. Read-only; anon may SELECT this view and not the tables under it (#630, #969, mypets.services).';

REVOKE ALL ON public.directory_public_listings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.directory_public_listings TO anon, authenticated;
GRANT SELECT ON public.directory_public_listings TO service_role;

-- ── Assertions ──────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  _cols text[];
  _opts text[];
  _priv text;
BEGIN
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO _cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.directory_public_listings'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF _cols IS DISTINCT FROM ARRAY['slug', 'display_name', 'logo_url', 'bio', 'service_lines',
                                  'coverage_zips', 'coverage_cities', 'services', 'published_at',
                                  'tagline', 'highlights', 'areas', 'books_online',
                                  'booking_policy_text', 'book_path', 'photos',
                                  'public_email', 'public_phone'] THEN
    RAISE EXCEPTION 'directory_public_listings has columns %', _cols;
  END IF;
  SELECT reloptions INTO _opts FROM pg_class WHERE oid = 'public.directory_public_listings'::regclass;
  IF NOT ('security_barrier=true' = ANY (COALESCE(_opts, '{}'))) THEN
    RAISE EXCEPTION 'directory_public_listings lost security_barrier';
  END IF;
  IF NOT has_table_privilege('anon', 'public.directory_public_listings', 'SELECT') THEN
    RAISE EXCEPTION 'a visitor cannot read directory_public_listings';
  END IF;
  FOREACH _priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('anon', 'public.directory_public_listings', _priv)
       OR has_table_privilege('authenticated', 'public.directory_public_listings', _priv) THEN
      RAISE EXCEPTION 'a client role holds % on directory_public_listings', _priv;
    END IF;
  END LOOP;
  -- The base table stays closed to a visitor: the contact is public only
  -- through the view, and only when published.
  IF has_column_privilege('anon', 'public.directory_profiles', 'public_email', 'SELECT')
     OR has_column_privilege('anon', 'public.directory_profiles', 'public_phone', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read the contact columns of directory_profiles directly';
  END IF;
END
$verify$;

