-- An account was a row in Users & roles and nothing else.
--
-- There was no page where somebody could see or change their own details.
-- Your name was set by whoever invited you and only an admin could edit it,
-- from a table of everybody. Your email was whatever you signed up with, with
-- no way to change it. There was no photo anywhere in the product — the
-- Avatar component has been in src/components/ui since the beginning and
-- nothing imported it — so the crew board, the dispatch lanes and the header
-- all identified people by a text name and a colour swatch.
--
-- Two things this adds:
--
--   staff.avatar_url   the storage PATH (not a URL) of the person's photo
--   storage bucket     'avatars', private, org-scoped like every other bucket
--
-- Named avatar_url rather than avatar_path because that is the name the rest
-- of the schema uses for this exact thing (organizations.logo_url also stores
-- a path). One wrong name consistently is easier than two right ones.
--
-- ── WHY PRIVATE ───────────────────────────────────────────────────────────
--
-- A public bucket would make every avatar a permanent, unauthenticated URL. A
-- photograph of an employee is personal data, and a URL that outlives their
-- employment is a leak nobody would notice. Every other bucket here is private
-- and read through a signed URL; this follows that rather than inventing an
-- exception for convenience.
--
-- ── THE PATH SHAPE CARRIES THE AUTHORIZATION ─────────────────────────────
--
--   {organization_id}/{user_id}/{timestamp}.{ext}
--
-- Folder 1 is the org, so `is_org_member` gates reads exactly as it does for
-- visit photos. Folder 2 is the owner, so write and delete can require
-- auth.uid() to match — a manager may rename a colleague from Users & roles,
-- but nobody replaces somebody else's photograph.

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS avatar_url text;

COMMENT ON COLUMN public.staff.avatar_url IS
  'Storage path in the private "avatars" bucket, org/user/timestamp.ext. Not a '
  'URL despite the name — read it with createSignedUrl. Named for consistency '
  'with organizations.logo_url, which stores a path too.';

INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "org members read avatars" ON storage.objects;
CREATE POLICY "org members read avatars" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'avatars'
    AND public.is_org_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

-- Write and delete are self-only. The org check stays as well: without it a
-- member of org A could write into org B's folder under their own user id,
-- and then every member of org B would be serving a file A controls.
DROP POLICY IF EXISTS "people upload their own avatar" ON storage.objects;
CREATE POLICY "people upload their own avatar" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'avatars'
    AND public.is_org_member(auth.uid(), ((storage.foldername(name))[1])::uuid)
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS "people replace their own avatar" ON storage.objects;
CREATE POLICY "people replace their own avatar" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS "people delete their own avatar" ON storage.objects;
CREATE POLICY "people delete their own avatar" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );
