-- A directory listing says which services book online (#630; mypets v2
-- step 7: booking exposure).
--
-- PROPOSED MIGRATION. File only: not applied to any live database by the
-- change that adds it.
--
-- WHY. The directory app (mypets.services, its own repo) is going to show
-- "Book online" beside a service when, and only when, the business can sell
-- that service on its own booking link right now; everything else stays
-- "Request a quote". Until this file directory_public_listings said nothing
-- about booking at all (G1), no business had written a cancellation or
-- refund policy a visitor could read before paying (G2), and nothing said a
-- booking came from the directory (G3, handled in the app: leads.source).
--
-- WHAT THIS ADDS, all of it additive:
--   * organizations.directory_booking_enabled: the owner's switch "Show Book
--     online on mypets.services". NOT NULL DEFAULT false, so every business
--     that exists today, and every one created later, is OFF until its owner
--     turns it on. Nothing in this file turns it on for anyone.
--   * organizations.booking_policy_text: the owner's own cancellation and
--     refund policy, at most 400 characters, trimmed, or NULL. Never written
--     for an owner; empty is allowed and reads NULL.
--   * set_directory_booking(_org, _enabled, _policy_text): the one writer of
--     both, OWNER only. A guard trigger refuses any other signed-in write of
--     the two columns (a settings manager can UPDATE organizations under RLS,
--     so the column needs its own lock, as vaccine_start_rule has).
--   * directory_public_listings, replaced in place with every existing
--     column kept, in order, and three added AT THE END:
--       books_online         true when at least one listed service can be
--                            booked online now (its booking_mode below is not
--                            request_only);
--       booking_policy_text  the owner's policy, or NULL;
--       book_path            '/d/{directory slug}/book' when books_online,
--                            else NULL: where the directory app sends a
--                            visitor. It names the DIRECTORY slug, which is
--                            already public, and never the business's own
--                            booking slug or id.
--     Each element of services[] keeps its four keys and gains three:
--       booking_mode  the EFFECTIVE mode (below);
--       booking_key   an opaque 12-character key for that listed service,
--                     for /d/{slug}/book?service=<key>. A hash, so neither
--                     the service's id nor the business's is in the view;
--       package       {name, sessions_count, price_cents} when booking_mode
--                     is package, else null. Never the package's id.
--   * directory_booking_handoff(_slug, _booking_key): the server's lookup for
--     /d/{slug}/book. SERVICE ROLE only (it returns a service id and the
--     business's booking slug), and it reads the VIEW, so the hand-off and
--     the listing cannot disagree about what is sellable.
--
-- THE EFFECTIVE MODE. request_only unless ALL of these hold:
--   1. organizations.directory_booking_enabled (this file's switch);
--   2. organizations.public_signup_enabled ("Accept signups online");
--   3. organizations.stripe_connect_charges_enabled (synced from Stripe;
--      only the platform may write it, 20260801053000);
--   4. the service is still active, of this business, on a line the
--      platform lets a visitor book (platform_service_lines.bookable, as
--      public_services filters), and priced unless it is zone-priced pet
--      waste (public_services' own terms);
--   5. its stored public_booking_mode is one_time or recurring, or package
--      with a package that can be sold: this business's, for this service,
--      active, sessions_count > 0 and price_cents > 0. A mobile groom is
--      never a package. These are storedPublicBookingMode and bookingFromRow
--      in src/lib/public-booking-mode(.server).ts, in SQL.
-- A stored request_only stays request_only. NULL reads request_only.
--
-- WHAT IT DOES NOT CHANGE. No payment, PaymentIntent, platform fee, Connect
-- or webhook behaviour. directory_search, directory_profiles_by_slug and
-- directory_public_rows keep their shape. The base tables stay REVOKE ALL
-- from anon; anon reads only the view. noindex is untouched.
--
-- Replays into an empty database: two columns, a CHECK, three functions, a
-- trigger, a view and grants, then assertions about what this file creates.
-- No rows are read or written.

-- ── 1. The switch and the policy ───────────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS directory_booking_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS booking_policy_text text;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_booking_policy_text_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_booking_policy_text_check
  CHECK (booking_policy_text IS NULL
         OR (char_length(booking_policy_text) BETWEEN 1 AND 400
             AND booking_policy_text = btrim(booking_policy_text)));

COMMENT ON COLUMN public.organizations.directory_booking_enabled IS
  'The owner''s "Show Book online on mypets.services" switch (#630, mypets v2 step 7). Default false for every business. Book online shows only when this, public_signup_enabled and stripe_connect_charges_enabled are all on and the service''s own mode can be sold. Written only by set_directory_booking (owner).';
COMMENT ON COLUMN public.organizations.booking_policy_text IS
  'The owner''s own cancellation and refund policy, at most 400 characters, or NULL (#630, mypets v2 step 7). Public on a published directory listing. Never written for an owner. Written only by set_directory_booking (owner).';

-- ── 2. Only the owner, only through the writer ─────────────────────────────
CREATE OR REPLACE FUNCTION public.organizations_guard_directory_booking()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF (NEW.directory_booking_enabled IS DISTINCT FROM OLD.directory_booking_enabled
      OR NEW.booking_policy_text IS DISTINCT FROM OLD.booking_policy_text)
     AND auth.uid() IS NOT NULL
     AND COALESCE(current_setting('app.directory_booking_writer', true), '') <> '1'
  THEN
    RAISE EXCEPTION 'Only an owner can change directory booking' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.organizations_guard_directory_booking() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organizations_guard_directory_booking ON public.organizations;
CREATE TRIGGER organizations_guard_directory_booking
  BEFORE UPDATE OF directory_booking_enabled, booking_policy_text ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_guard_directory_booking();

CREATE OR REPLACE FUNCTION public.set_directory_booking(_org uuid, _enabled boolean, _policy_text text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _p text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), _org, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only an owner can change directory booking' USING ERRCODE = '42501';
  END IF;
  _p := NULLIF(btrim(COALESCE(_policy_text, '')), '');
  IF char_length(_p) > 400 THEN
    RAISE EXCEPTION 'The cancellation and refund policy is at most 400 characters' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.directory_booking_writer', '1', true);
  UPDATE public.organizations
     SET directory_booking_enabled = COALESCE(_enabled, false),
         booking_policy_text = _p
   WHERE id = _org;
  PERFORM set_config('app.directory_booking_writer', '', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = '22023';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.set_directory_booking(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_directory_booking(uuid, boolean, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.set_directory_booking(uuid, boolean, text) IS
  'The owner turns "Show Book online on mypets.services" on or off and sets the cancellation and refund policy (<= 400, trimmed, empty = NULL). Anyone else is refused (42501). #630, mypets v2 step 7.';

-- ── 3. The public view, three columns longer ───────────────────────────────
-- CREATE OR REPLACE VIEW may only ADD columns at the end, so the twelve that
-- 20261112090000 left are kept by name, type and position. `services` keeps
-- its type (jsonb) and its four keys; each element gains booking_mode,
-- booking_key and package. The per-service answer is worked out once, in the
-- LATERAL below, so books_online and every booking_mode come from the same
-- expression.
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
         CASE WHEN COALESCE(bk.books_online, false) THEN '/d/' || p.slug || '/book' END AS book_path
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
  'Every PUBLISHED directory profile of a live business, in the public shape only (slug, display_name, logo_url, bio, service_lines, coverage_zips, coverage_cities, services[label, service_line, price_from_cents, price_unit, booking_mode, booking_key, package{name, sessions_count, price_cents}], published_at, tagline, highlights, areas[name, zips], books_online, booking_policy_text, book_path). booking_mode is request_only unless the owner''s directory switch, public signup and Stripe charges are all on and the service''s own mode can be sold. Read-only; anon may SELECT this view and not the tables under it (#630, mypets.services).';

REVOKE ALL ON public.directory_public_listings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.directory_public_listings TO anon, authenticated;
GRANT SELECT ON public.directory_public_listings TO service_role;

-- ── 4. The hand-off's lookup (service role only) ───────────────────────────
-- /d/{slug}/book on the HoundStack server: a PUBLISHED directory slug of a
-- live business, and the booking_key of one of its listed services, to the
-- business's own booking slug, that service's id and its effective mode, as
-- the view says it. No row: no such published listing. A key that names no
-- listed service: service_id NULL, booking_mode request_only.
CREATE OR REPLACE FUNCTION public.directory_booking_handoff(_slug text, _booking_key text)
 RETURNS TABLE (signup_slug text, service_id uuid, booking_mode text, books_online boolean)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT COALESCE(NULLIF(btrim(o.portal_slug), ''), o.slug)::text,
         ds.service_id,
         COALESCE(e.item->>'booking_mode', 'request_only')::text,
         v.books_online
    FROM public.directory_public_listings v
    JOIN public.directory_profiles p ON p.slug = v.slug
    JOIN public.organizations o ON o.id = p.organization_id
    LEFT JOIN LATERAL (
      SELECT x AS item FROM jsonb_array_elements(v.services) AS u(x)
       WHERE x->>'booking_key' = _booking_key
       LIMIT 1
    ) e ON true
    LEFT JOIN public.directory_profile_services ds
      ON ds.organization_id = p.organization_id
     AND e.item IS NOT NULL
     AND left(md5('directory-service:' || ds.service_id::text), 12) = _booking_key
   WHERE v.slug = lower(btrim(_slug));
$fn$;

REVOKE ALL ON FUNCTION public.directory_booking_handoff(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.directory_booking_handoff(text, text) TO service_role;

COMMENT ON FUNCTION public.directory_booking_handoff(text, text) IS
  'The server''s lookup for /d/{directory slug}/book (#630, mypets v2 step 7): the business''s booking slug, the listed service''s id and its effective booking_mode, read from directory_public_listings. Service role only: it returns ids.';

-- ── 5. What this file establishes ──────────────────────────────────────────
DO $check$
DECLARE _priv text; _cols text[]; _fn text; _def text;
BEGIN
  -- Off for everyone, by default, and the default is false rather than NULL.
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO _def
    FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.organizations'::regclass AND a.attname = 'directory_booking_enabled';
  IF _def IS DISTINCT FROM 'false' OR NOT (
    SELECT attnotnull FROM pg_attribute
     WHERE attrelid = 'public.organizations'::regclass AND attname = 'directory_booking_enabled') THEN
    RAISE EXCEPTION 'directory_booking_enabled is not NOT NULL DEFAULT false (default %)', _def;
  END IF;

  -- The base tables are still shut to a visitor. organizations carries an
  -- old table-level grant to anon, but RLS is on and no permissive policy
  -- names anon (or PUBLIC) for reading it, so a visitor reads no row of it,
  -- and so none of the two columns this file adds.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.organizations'::regclass)
     OR EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'organizations'
          AND permissive = 'PERMISSIVE' AND cmd IN ('SELECT', 'ALL')
          AND roles && ARRAY['anon', 'public']::name[]) THEN
    RAISE EXCEPTION 'a visitor can read organizations';
  END IF;
  FOREACH _priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('anon', 'public.directory_profiles', _priv)
       OR has_table_privilege('anon', 'public.directory_profile_services', _priv)
       OR has_table_privilege('anon', 'public.directory_profile_areas', _priv)
       OR has_table_privilege('anon', 'public.services', _priv)
       OR has_table_privilege('anon', 'public.service_packages', _priv) THEN
      RAISE EXCEPTION 'anon holds % on a table under the directory view', _priv;
    END IF;
  END LOOP;

  -- The writer asks for an owner before it writes, and anon cannot call it.
  _fn := 'public.set_directory_booking(uuid, boolean, text)';
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is callable by anon', _fn;
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = _fn::regprocedure),
            'public.has_role(auth.uid(), _org, ''owner''::public.app_role)') = 0 THEN
    RAISE EXCEPTION '% does not ask for an owner', _fn;
  END IF;
  FOREACH _fn IN ARRAY ARRAY[
    'public.organizations_guard_directory_booking()',
    'public.directory_booking_handoff(text, text)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable by a client role', _fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.organizations'::regclass AND tgname = 'organizations_guard_directory_booking'
  ) THEN
    RAISE EXCEPTION 'the directory booking guard trigger is missing';
  END IF;

  -- The view: the twelve columns it had, in place, then the three this adds.
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO _cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.directory_public_listings'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF _cols IS DISTINCT FROM ARRAY['slug', 'display_name', 'logo_url', 'bio', 'service_lines',
                                  'coverage_zips', 'coverage_cities', 'services', 'published_at',
                                  'tagline', 'highlights', 'areas',
                                  'books_online', 'booking_policy_text', 'book_path'] THEN
    RAISE EXCEPTION 'directory_public_listings has columns %', _cols;
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
END
$check$;
