-- A directory photo is public only after a moderator approves it (#630;
-- mypets v2 step 5b: photos and moderation).
--
-- PROPOSED MIGRATION. File only: not applied to any live database by the
-- change that adds it. The storage bucket is created HERE, by this file, and
-- nowhere else: not from a dashboard, not from a one-off SQL session.
--
-- WHY. A directory profile (mypets.services, its own repo) is going to show
-- the business's own photos. Brief section 4 item 2: up to 8 per profile,
-- alt text required, the owner attests "I took these or have the rights to
-- use them, and they are not AI-generated", and each photo is held for
-- moderation by HoundStack, the same queue model as reviews
-- (20261110120100). Only approved photos are public. No credit line is shown
-- anywhere, and no source or licence record is public.
--
-- WHAT THIS ADDS, all of it additive:
--   * storage bucket directory-photos: PRIVATE (public = false), 5 MB,
--     JPEG / PNG / WebP. Objects live at {organization id}/{uuid}.{ext}.
--     Storage policies: a business's OWNER may upload into, read and delete
--     from its own folder; a platform admin may read (to moderate). No
--     policy names anon, and nobody may overwrite an object, so a pending or
--     rejected photo cannot be fetched by a visitor and an approved one
--     cannot be swapped for something else after it was approved.
--   * directory_profile_photos(id, organization_id, path, alt, position,
--     rights_attested_at, status, moderated_by, moderated_at, created_at,
--     updated_at). RLS on, two-step sign-in (require_mfa_policy), no grant
--     to anon. The OWNER of the business may insert, update and delete its
--     own rows under RLS; a guard trigger holds them to the rules:
--       - a new photo is always 'pending', whatever the insert said;
--       - rights_attested_at must be given (the owner ticked the attestation)
--         and is stamped now() by the database, so it cannot be backdated or
--         left out: an upload without the attestation is refused (22023);
--       - alt text is required, one line, 1 to 140 characters;
--       - the path is the business's own folder, and never changes;
--       - an owner may change alt and position only. A new alt sends an
--         approved or rejected photo back to 'pending' (an approved photo
--         whose words changed is not approved any more, as a review edit);
--       - status, moderated_by and moderated_at change only inside
--         moderate_directory_photo (no self-approval);
--       - THE LIMIT: at most 8 photos per business that are pending or
--         approved. A rejected photo does not count, so a rejected one never
--         blocks its replacement; the owner may also delete it. Taken under
--         a per-business advisory lock, so two uploads at once cannot both
--         be the eighth.
--   * directory_photo_queue / moderate_directory_photo: platform admins
--     only, asked inside each function (is_platform_admin(auth.uid())), as
--     the review queue does. The queue returns the private path so the
--     console can show the moderator the image; it is never public.
--   * directory_public_listings, replaced in place with every existing column
--     kept, in order, and ONE added AT THE END:
--       photos  jsonb array of {url, alt, position} for APPROVED photos only,
--               ordered by position. url is '/d/{directory slug}/photos/{key}',
--               a HoundStack path whose key is an opaque hash of the photo's
--               id: no storage path, no bucket name, no organization id.
--   * directory_photo_object(_slug, _key): the server's lookup for that URL.
--     SERVICE ROLE only (it returns the private path), and it reads the VIEW,
--     so the server serves exactly the photos the listing shows: an approved
--     photo of a published listing of a live business, and nothing else.
--
-- HOW A VISITOR GETS THE IMAGE. GET /d/{slug}/photos/{key} on the HoundStack
-- server asks directory_photo_object, and only when it names an approved
-- photo reads the object with the service role and returns the bytes. So the
-- public URL exists only for an approved photo, a photo rejected after
-- approval stops being served within the response's cache lifetime, and the
-- storage path never leaves the server (a signed URL would carry it, and the
-- organization id inside it, to every visitor).
--
-- WHAT IT DOES NOT CHANGE. directory_search, directory_profiles_by_slug,
-- directory_public_rows and directory_booking_handoff keep their shape. The
-- base tables stay REVOKE ALL from anon; anon reads only the view. noindex is
-- untouched. No credit line is stored or shown: the table has no source,
-- photographer or licence column, and the view has none either.
--
-- Replays into an empty database: a bucket row, a table, functions, a
-- trigger, policies, a view and grants, then assertions about what this file
-- creates. No tenant rows are read or written.

-- ── 1. The bucket ───────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('directory-photos', 'directory-photos', false, 5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false,
  file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── 2. The table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.directory_profile_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  path text NOT NULL,
  alt text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  rights_attested_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  moderated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  moderated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT directory_profile_photos_path_key UNIQUE (path),
  -- {organization id}/{uuid}.{jpg|png|webp}, in the business's own folder.
  CONSTRAINT directory_profile_photos_path_check CHECK (
    path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
    AND split_part(path, '/', 1) = organization_id::text
  ),
  CONSTRAINT directory_profile_photos_alt_check CHECK (
    char_length(alt) BETWEEN 1 AND 140 AND alt = btrim(alt) AND alt !~ '[\r\n\t]'
  ),
  CONSTRAINT directory_profile_photos_position_check CHECK (position BETWEEN 0 AND 99),
  CONSTRAINT directory_profile_photos_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  -- A decision always says who and when; a pending photo has neither.
  CONSTRAINT directory_profile_photos_moderated_iff_decided CHECK ((status = 'pending') = (moderated_at IS NULL))
);

COMMENT ON TABLE public.directory_profile_photos IS
  'A directory profile''s own photos (#630, mypets v2 step 5b). At most 8 pending or approved per business (rejected ones do not count). Alt text required (<= 140). rights_attested_at: when the owner attested "I took these or have the rights to use them, and they are not AI-generated"; required, stamped by the database. Held for moderation: status starts pending, a new alt returns it to pending, and only a platform admin (moderate_directory_photo) approves or rejects. path is the private object in storage bucket directory-photos and is never public; visitors get approved photos only, through directory_public_listings.photos.';
COMMENT ON COLUMN public.directory_profile_photos.path IS
  'The object in the PRIVATE storage bucket directory-photos: {organization id}/{uuid}.{ext}. Never public.';
COMMENT ON COLUMN public.directory_profile_photos.rights_attested_at IS
  'When the owner accepted "I took these or have the rights to use them, and they are not AI-generated". NOT NULL: an upload without it is refused.';

CREATE INDEX IF NOT EXISTS directory_profile_photos_org_idx
  ON public.directory_profile_photos (organization_id, position);
CREATE INDEX IF NOT EXISTS directory_profile_photos_pending_idx
  ON public.directory_profile_photos (updated_at) WHERE status = 'pending';

-- ── 3. The rules, held by a trigger ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.directory_profile_photos_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _moderator boolean := COALESCE(current_setting('app.directory_photo_moderator', true), '') = '1';
  _n integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.rights_attested_at IS NULL THEN
      RAISE EXCEPTION 'Confirm you took these photos or have the rights to use them, and they are not AI-generated'
        USING ERRCODE = '22023';
    END IF;
    -- Stamped by the database: never backdated, never in the future.
    NEW.rights_attested_at := now();
    -- New is pending, whoever inserts it.
    NEW.status := 'pending';
    NEW.moderated_by := NULL;
    NEW.moderated_at := NULL;
    NEW.created_at := now();
    NEW.updated_at := now();
  ELSE
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.path IS DISTINCT FROM OLD.path
       OR NEW.rights_attested_at IS DISTINCT FROM OLD.rights_attested_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A photo''s business, file and attestation do not change' USING ERRCODE = '42501';
    END IF;
    IF (NEW.status IS DISTINCT FROM OLD.status
        OR NEW.moderated_by IS DISTINCT FROM OLD.moderated_by
        OR NEW.moderated_at IS DISTINCT FROM OLD.moderated_at)
       AND NOT _moderator THEN
      RAISE EXCEPTION 'Only a HoundStack moderator can approve or reject a photo' USING ERRCODE = '42501';
    END IF;
    -- New words are not the words a moderator approved.
    IF NEW.alt IS DISTINCT FROM OLD.alt AND NOT _moderator THEN
      NEW.status := 'pending';
      NEW.moderated_by := NULL;
      NEW.moderated_at := NULL;
    END IF;
    NEW.updated_at := now();
  END IF;

  -- At most eight that are pending or approved. Rejected ones do not count.
  IF NEW.status <> 'rejected' AND (TG_OP = 'INSERT' OR OLD.status = 'rejected') THEN
    PERFORM pg_advisory_xact_lock(hashtext('directory_profile_photos:' || NEW.organization_id::text));
    SELECT count(*) INTO _n
      FROM public.directory_profile_photos
     WHERE organization_id = NEW.organization_id
       AND status <> 'rejected'
       AND id <> NEW.id;
    IF _n >= 8 THEN
      RAISE EXCEPTION 'A directory profile has at most 8 photos. Remove one first.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.directory_profile_photos_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS directory_profile_photos_guard ON public.directory_profile_photos;
CREATE TRIGGER directory_profile_photos_guard
  BEFORE INSERT OR UPDATE ON public.directory_profile_photos
  FOR EACH ROW EXECUTE FUNCTION public.directory_profile_photos_guard();

-- ── 4. Row-level security: the owner, and nobody else ───────────────────────
ALTER TABLE public.directory_profile_photos ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.directory_profile_photos');

REVOKE ALL ON public.directory_profile_photos FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.directory_profile_photos TO authenticated;
GRANT UPDATE (alt, position) ON public.directory_profile_photos TO authenticated;
GRANT ALL ON public.directory_profile_photos TO service_role;

DROP POLICY IF EXISTS "directory photos owner read" ON public.directory_profile_photos;
CREATE POLICY "directory photos owner read" ON public.directory_profile_photos
  FOR SELECT TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));
DROP POLICY IF EXISTS "directory photos owner insert" ON public.directory_profile_photos;
CREATE POLICY "directory photos owner insert" ON public.directory_profile_photos
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));
DROP POLICY IF EXISTS "directory photos owner update" ON public.directory_profile_photos;
CREATE POLICY "directory photos owner update" ON public.directory_profile_photos
  FOR UPDATE TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role))
  WITH CHECK (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));
DROP POLICY IF EXISTS "directory photos owner delete" ON public.directory_profile_photos;
CREATE POLICY "directory photos owner delete" ON public.directory_profile_photos
  FOR DELETE TO authenticated
  USING (public.has_role((SELECT auth.uid()), organization_id, 'owner'::public.app_role));

-- ── 5. Storage policies for the bucket ──────────────────────────────────────
-- The object name has to be {organization id}/{uuid}.{ext}; the caller has to
-- be that business's owner (or, to read, a platform admin).
CREATE OR REPLACE FUNCTION public.can_use_directory_photo(name text, write boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _parts text[] := string_to_array(name, '/');
  _org uuid;
BEGIN
  IF auth.uid() IS NULL OR COALESCE(array_length(_parts, 1), 0) <> 2
    OR _parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR _parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  THEN RETURN false; END IF;
  _org := _parts[1]::uuid;
  IF public.has_role(auth.uid(), _org, 'owner'::public.app_role) THEN RETURN true; END IF;
  RETURN NOT write AND public.is_platform_admin(auth.uid());
END
$fn$;

REVOKE ALL ON FUNCTION public.can_use_directory_photo(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_use_directory_photo(text, boolean) TO authenticated, service_role;

DROP POLICY IF EXISTS "directory photos read" ON storage.objects;
CREATE POLICY "directory photos read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'directory-photos' AND public.can_use_directory_photo(name, false));
DROP POLICY IF EXISTS "directory photos upload" ON storage.objects;
CREATE POLICY "directory photos upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'directory-photos' AND public.can_use_directory_photo(name, true));
DROP POLICY IF EXISTS "directory photos delete" ON storage.objects;
CREATE POLICY "directory photos delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'directory-photos' AND public.can_use_directory_photo(name, true));
-- No UPDATE policy: an object is never overwritten, so what a moderator
-- approved is what a visitor sees.

-- ── 6. The moderator's queue ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.directory_photo_queue(_status text DEFAULT 'pending')
 RETURNS TABLE (
   id uuid,
   business_name text,
   profile_slug text,
   path text,
   alt text,
   "position" integer,
   status text,
   rights_attested_at timestamptz,
   created_at timestamptz,
   updated_at timestamptz,
   moderated_at timestamptz,
   moderated_by uuid
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only a HoundStack moderator can read the photo queue' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT ph.id, o.name, p.slug, ph.path, ph.alt, ph.position, ph.status, ph.rights_attested_at,
           ph.created_at, ph.updated_at, ph.moderated_at, ph.moderated_by
      FROM public.directory_profile_photos ph
      JOIN public.organizations o ON o.id = ph.organization_id
      LEFT JOIN public.directory_profiles p ON p.organization_id = ph.organization_id
     WHERE ph.status = COALESCE(_status, 'pending')
     ORDER BY ph.updated_at
     LIMIT 200;
END
$fn$;

CREATE OR REPLACE FUNCTION public.moderate_directory_photo(_id uuid, _approve boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _n integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only a HoundStack moderator can approve or reject a photo' USING ERRCODE = '42501';
  END IF;
  IF _approve IS NULL THEN
    RAISE EXCEPTION 'approve or reject' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.directory_photo_moderator', '1', true);
  UPDATE public.directory_profile_photos
     SET status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
         moderated_by = auth.uid(),
         moderated_at = now()
   WHERE id = _id;
  -- Counted before set_config, which would reset FOUND.
  GET DIAGNOSTICS _n = ROW_COUNT;
  PERFORM set_config('app.directory_photo_moderator', '', true);
  IF _n = 0 THEN
    RAISE EXCEPTION 'no such photo' USING ERRCODE = 'P0002';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.directory_photo_queue(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.moderate_directory_photo(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_photo_queue(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.moderate_directory_photo(uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.directory_photo_queue(text) IS
  'The directory photo moderation queue (#630, mypets v2 step 5b). Platform admins only. Returns the private path so the console can show the moderator the image; never public.';
COMMENT ON FUNCTION public.moderate_directory_photo(uuid, boolean) IS
  'A platform admin approves or rejects a directory photo; records moderated_by and moderated_at (#630, mypets v2 step 5b).';

-- ── 7. The public view, one column longer ───────────────────────────────────
-- CREATE OR REPLACE VIEW may only ADD columns at the end, so the fifteen that
-- 20261112100000 left are kept by name, type and position, with their
-- expressions unchanged; photos is added after book_path.
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

-- ── 8. The photo URL's lookup (service role only) ───────────────────────────
-- /d/{slug}/photos/{key} on the HoundStack server: a PUBLISHED directory slug
-- of a live business and the key of one of its APPROVED photos, to that
-- photo's private path. Read from the view, so it serves what the listing
-- shows and nothing else. No row: nothing to serve.
CREATE OR REPLACE FUNCTION public.directory_photo_object(_slug text, _key text)
 RETURNS TABLE (path text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT ph.path
    FROM public.directory_public_listings v
    JOIN public.directory_profiles p ON p.slug = v.slug
    JOIN public.directory_profile_photos ph
      ON ph.organization_id = p.organization_id
     AND ph.status = 'approved'
     AND left(md5('directory-photo:' || ph.id::text), 16) = _key
   WHERE v.slug = lower(btrim(_slug))
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.photos) AS u(e)
                  WHERE e->>'url' = '/d/' || v.slug || '/photos/' || _key)
   LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION public.directory_photo_object(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.directory_photo_object(text, text) TO service_role;

COMMENT ON FUNCTION public.directory_photo_object(text, text) IS
  'The server''s lookup for /d/{directory slug}/photos/{key} (#630, mypets v2 step 5b): the private path of an APPROVED photo of a published listing of a live business, read through directory_public_listings. Service role only: it returns a storage path.';

-- ── 9. What this file establishes ───────────────────────────────────────────
DO $check$
DECLARE _priv text; _cols text[]; _fn text; _cmd text;
BEGIN
  -- The bucket is private, with its limits.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'directory-photos'
    AND NOT public AND file_size_limit = 5242880
    AND allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']) THEN
    RAISE EXCEPTION 'the directory-photos bucket is missing, public, or without its limits';
  END IF;
  -- Its policies: read, upload and delete for authenticated through the
  -- checker, no UPDATE, and none that names anon or PUBLIC.
  FOREACH _cmd IN ARRAY ARRAY['SELECT', 'INSERT', 'DELETE'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd = _cmd AND roles = ARRAY['authenticated']::name[] AND permissive = 'PERMISSIVE'
      AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%directory-photos%can_use_directory_photo%') THEN
      RAISE EXCEPTION 'directory-photos storage % policy missing', _cmd;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%directory-photos%'
      AND (cmd IN ('UPDATE', 'ALL') OR roles && ARRAY['anon', 'public']::name[])) THEN
    RAISE EXCEPTION 'a directory-photos storage policy lets anon in or allows an overwrite';
  END IF;

  -- The table: RLS on, two-step sign-in, shut to anon, no client UPDATE of
  -- anything but alt and position.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.directory_profile_photos'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'directory_profile_photos' AND permissive = 'RESTRICTIVE') THEN
    RAISE EXCEPTION 'directory_profile_photos is missing RLS or its two-step sign-in policy';
  END IF;
  FOREACH _priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('anon', 'public.directory_profile_photos', _priv) THEN
      RAISE EXCEPTION 'anon holds % on directory_profile_photos', _priv;
    END IF;
  END LOOP;
  FOREACH _priv IN ARRAY ARRAY['status', 'moderated_by', 'moderated_at', 'path', 'organization_id',
                                'rights_attested_at', 'id', 'created_at', 'updated_at'] LOOP
    IF has_column_privilege('authenticated', 'public.directory_profile_photos', _priv, 'UPDATE') THEN
      RAISE EXCEPTION 'a signed-in user can UPDATE directory_profile_photos.%', _priv;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'directory_profile_photos'
              AND permissive = 'PERMISSIVE' AND roles && ARRAY['anon', 'public']::name[]) THEN
    RAISE EXCEPTION 'a permissive policy on directory_profile_photos names anon or PUBLIC';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'directory_profile_photos'
       AND permissive = 'PERMISSIVE'
       AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%has_role%owner%') <> 4 THEN
    RAISE EXCEPTION 'directory_profile_photos does not have exactly four owner policies';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.directory_profile_photos'::regclass
                  AND tgname = 'directory_profile_photos_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'the directory photo guard trigger is missing';
  END IF;
  -- The limit, the attestation and pending-on-insert are in the guard.
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.directory_profile_photos_guard()'::regprocedure),
            'IF _n >= 8 THEN') = 0
     OR strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.directory_profile_photos_guard()'::regprocedure),
            'IF NEW.rights_attested_at IS NULL THEN') = 0
     OR strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.directory_profile_photos_guard()'::regprocedure),
            'NEW.status := ''pending'';') = 0 THEN
    RAISE EXCEPTION 'the directory photo guard does not hold the limit, the attestation or pending';
  END IF;

  -- Functions: who may call what.
  FOREACH _fn IN ARRAY ARRAY['public.directory_photo_queue(text)', 'public.moderate_directory_photo(uuid, boolean)'] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute %', _fn;
    END IF;
    IF strpos((SELECT prosrc FROM pg_proc WHERE oid = _fn::regprocedure), 'public.is_platform_admin(auth.uid())') = 0 THEN
      RAISE EXCEPTION '% does not ask for a platform admin', _fn;
    END IF;
  END LOOP;
  FOREACH _fn IN ARRAY ARRAY['public.directory_profile_photos_guard()', 'public.directory_photo_object(text, text)'] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable by a client role', _fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.can_use_directory_photo(text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute can_use_directory_photo';
  END IF;

  -- The view: the fifteen columns it had, in place, then photos.
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO _cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.directory_public_listings'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF _cols IS DISTINCT FROM ARRAY['slug', 'display_name', 'logo_url', 'bio', 'service_lines',
                                  'coverage_zips', 'coverage_cities', 'services', 'published_at',
                                  'tagline', 'highlights', 'areas',
                                  'books_online', 'booking_policy_text', 'book_path',
                                  'photos'] THEN
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
  -- The tables under the view stay shut to a visitor.
  FOREACH _priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', 'public.directory_profiles', _priv)
       OR has_table_privilege('anon', 'public.directory_profile_services', _priv)
       OR has_table_privilege('anon', 'public.directory_profile_areas', _priv) THEN
      RAISE EXCEPTION 'anon holds % on a table under the directory view', _priv;
    END IF;
  END LOOP;
END
$check$;
