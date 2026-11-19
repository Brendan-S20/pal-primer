-- ROLLBACK for 20261118010000_a-directory-profile-can-publish-a-contact.sql (#969).
--
-- WHAT THIS UNDOES:
--   * Recreates directory_public_listings without public_email and
--     public_phone (a view cannot lose a column with CREATE OR REPLACE, so it
--     is dropped and recreated; the grants are put back).
--   * Drops directory_profiles.public_email and public_phone and their checks.
--
-- WHAT THIS DOES **NOT** UNDO -- read before running:
--   * Every published contact is DELETED with the columns. Copy them first:
--       SELECT organization_id, public_email, public_phone
--         FROM public.directory_profiles
--        WHERE public_email IS NOT NULL OR public_phone IS NOT NULL;
--   * Revert mypets PR #18 first (or run this when it is not deployed): it
--     selects both columns and would fail on a view without them.
--   * directory_photo_object() is a SQL function reading the view; it is
--     stored as text, so dropping the view does not drop it.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/20261118010000_a-directory-profile-can-publish-a-contact.down.sql

BEGIN;
DROP VIEW IF EXISTS public.directory_public_listings;
ALTER TABLE public.directory_profiles DROP CONSTRAINT IF EXISTS directory_profiles_public_email_check;
ALTER TABLE public.directory_profiles DROP CONSTRAINT IF EXISTS directory_profiles_public_phone_check;
ALTER TABLE public.directory_profiles DROP COLUMN IF EXISTS public_email;
ALTER TABLE public.directory_profiles DROP COLUMN IF EXISTS public_phone;

-- The 16-column view exactly as 20261112110000 defined it.
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
         ), '[]'::jsonb) AS photos
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
  'Every PUBLISHED directory profile of a live business, in the public shape only (slug, display_name, logo_url, bio, service_lines, coverage_zips, coverage_cities, services[label, service_line, price_from_cents, price_unit, booking_mode, booking_key, package{name, sessions_count, price_cents}], published_at, tagline, highlights, areas[name, zips], books_online, booking_policy_text, book_path, photos[url, alt, position]). booking_mode is request_only unless the owner''s directory switch, public signup and Stripe charges are all on and the service''s own mode can be sold. photos are APPROVED photos only; url is a HoundStack path (/d/{slug}/photos/{opaque key}), never a storage path. Read-only; anon may SELECT this view and not the tables under it (#630, mypets.services).';
REVOKE ALL ON public.directory_public_listings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.directory_public_listings TO anon, authenticated;
GRANT SELECT ON public.directory_public_listings TO service_role;
COMMIT;
