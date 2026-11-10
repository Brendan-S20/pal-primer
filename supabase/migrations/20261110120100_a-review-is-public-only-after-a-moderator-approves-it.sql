-- A review is public only after a moderator approves it (#630).
--
-- PROPOSED MIGRATION. Not applied to any live database by the change that
-- adds it.
--
-- THE DECISION (Brendan, 2026-11-09): reviews in HoundStack's directory are
-- held for moderation. A review is NEVER public until a moderator approves
-- it. Brendan is the only moderator for now, so the queue belongs to the
-- platform admins (public.is_platform_admin), not to the business reviewed.
--
-- WHAT THIS ADDS
--   * directory_reviews: one per client per business (an edit, not a second
--     review), 1 to 5 stars and text, and a status that starts 'pending'.
--     Every new review AND every edit is pending; only moderate_directory_review
--     makes one 'approved' or 'rejected'.
--   * Rejection names one of the written rules applied to every review alike
--     (FTC 16 CFR 465.7(b) territory): abusive or defamatory, another
--     person's personal information, believed fake, unrelated. Never the
--     rating: there is no "too negative" reason.
--   * submit_directory_review (service role only): the server's way in, once a
--     review invite has been checked. Refuses a client of a business that is
--     not listed, a client with no completed visit and no paid invoice there,
--     and a client whose email is a staff member's of that business.
--   * directory_review_queue / moderate_directory_review: platform admins
--     only, asked inside the function (is_platform_admin(auth.uid()), which
--     also requires two-step sign-in where the admin has it).
--   * directory_public_reviews(slug): what a visitor reads. APPROVED reviews
--     of a PUBLISHED profile of a live business, and only rating, text and
--     date: no client id, no name, no email.
--
-- Nothing here sends anything. How a client is asked to review (a single-use
-- invite tied to a completed visit or paid invoice) is the next change, and
-- its wording is Brendan's; until then no client-facing page calls
-- submit_directory_review.
--
-- Replays into an empty database: a table, functions, policies and grants,
-- then assertions about what this file creates. No rows are read or written.

CREATE TABLE IF NOT EXISTS public.directory_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  rating smallint NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  rejection_reason text,
  moderated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  moderated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT directory_reviews_one_per_client UNIQUE (organization_id, client_id),
  CONSTRAINT directory_reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT directory_reviews_body_check CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  CONSTRAINT directory_reviews_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT directory_reviews_reason_check CHECK (
    rejection_reason IS NULL
    OR rejection_reason IN ('abusive_or_defamatory', 'personal_info', 'believed_fake', 'unrelated')
  ),
  -- A rejection always says which rule; nothing else carries a reason.
  CONSTRAINT directory_reviews_reason_iff_rejected CHECK ((status = 'rejected') = (rejection_reason IS NOT NULL))
);

COMMENT ON TABLE public.directory_reviews IS
  'Reviews of a business in HoundStack''s directory (#630). Held for moderation: status starts pending, every edit returns it to pending, and only a platform admin (moderate_directory_review) approves or rejects. Visitors read approved rows only, through directory_public_reviews.';

CREATE INDEX IF NOT EXISTS directory_reviews_pending_idx
  ON public.directory_reviews (created_at) WHERE status = 'pending';

ALTER TABLE public.directory_reviews ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.directory_reviews');

-- No client role reads or writes the table: the business does not see a
-- pending review (it cannot hide one, and should not lean on the moderator),
-- and visitors go through directory_public_reviews.
REVOKE ALL ON public.directory_reviews FROM anon, authenticated;
GRANT ALL ON public.directory_reviews TO service_role;

-- ── The server's way in ───────────────────────────────────────────────────
-- Returns the review's id. An existing review by the same client is EDITED
-- (rating and text replaced) and goes back to pending: an approved review
-- that changes is not approved any more.
CREATE OR REPLACE FUNCTION public.submit_directory_review(_client_id uuid, _rating integer, _body text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _org uuid;
  _email text;
  _id uuid;
BEGIN
  SELECT c.organization_id, lower(btrim(c.primary_email)) INTO _org, _email
    FROM public.clients c WHERE c.id = _client_id;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'not a client' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.directory_profiles p
      JOIN public.organizations o ON o.id = p.organization_id
     WHERE p.organization_id = _org AND p.published AND o.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'this business is not listed in the directory' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.visits v
        WHERE v.client_id = _client_id AND v.organization_id = _org AND v.status = 'completed')
     AND NOT EXISTS (
       SELECT 1 FROM public.invoices i
        WHERE i.client_id = _client_id AND i.organization_id = _org AND i.status = 'paid') THEN
    RAISE EXCEPTION 'only a client with a completed visit or a paid invoice can review' USING ERRCODE = '42501';
  END IF;
  IF _email IS NOT NULL AND _email <> '' AND EXISTS (
    SELECT 1 FROM public.staff s JOIN auth.users u ON u.id = s.user_id
     WHERE s.organization_id = _org AND lower(u.email) = _email
  ) THEN
    RAISE EXCEPTION 'staff cannot review their own business' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.directory_reviews AS r (organization_id, client_id, rating, body)
  VALUES (_org, _client_id, _rating, btrim(_body))
  ON CONFLICT (organization_id, client_id) DO UPDATE SET
    rating = EXCLUDED.rating,
    body = EXCLUDED.body,
    status = 'pending',
    rejection_reason = NULL,
    moderated_by = NULL,
    moderated_at = NULL,
    updated_at = now()
  RETURNING r.id INTO _id;
  RETURN _id;
END
$fn$;

REVOKE ALL ON FUNCTION public.submit_directory_review(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_directory_review(uuid, integer, text) TO service_role;

-- ── The moderator's queue ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.directory_review_queue(_status text DEFAULT 'pending')
 RETURNS TABLE (
   id uuid,
   business_name text,
   profile_slug text,
   rating smallint,
   body text,
   status text,
   rejection_reason text,
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
    RAISE EXCEPTION 'Only a HoundStack moderator can read the review queue' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT r.id, o.name, p.slug, r.rating, r.body, r.status, r.rejection_reason,
           r.created_at, r.updated_at, r.moderated_at, r.moderated_by
      FROM public.directory_reviews r
      JOIN public.organizations o ON o.id = r.organization_id
      LEFT JOIN public.directory_profiles p ON p.organization_id = r.organization_id
     WHERE r.status = COALESCE(_status, 'pending')
     ORDER BY r.updated_at
     LIMIT 200;
END
$fn$;

CREATE OR REPLACE FUNCTION public.moderate_directory_review(_id uuid, _approve boolean, _reason text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only a HoundStack moderator can approve or reject a review' USING ERRCODE = '42501';
  END IF;
  IF NOT _approve AND (_reason IS NULL OR _reason NOT IN
       ('abusive_or_defamatory', 'personal_info', 'believed_fake', 'unrelated')) THEN
    RAISE EXCEPTION 'a rejection names one of the written rules' USING ERRCODE = '22023';
  END IF;
  UPDATE public.directory_reviews
     SET status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
         rejection_reason = CASE WHEN _approve THEN NULL ELSE _reason END,
         moderated_by = auth.uid(),
         moderated_at = now()
   WHERE id = _id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such review' USING ERRCODE = 'P0002';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.directory_review_queue(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.moderate_directory_review(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.directory_review_queue(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.moderate_directory_review(uuid, boolean, text) TO authenticated, service_role;

-- ── What a visitor reads ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.directory_public_reviews(_slug text)
 RETURNS TABLE (rating smallint, body text, reviewed_at timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT r.rating, r.body, r.created_at
    FROM public.directory_reviews r
    JOIN public.directory_profiles p ON p.organization_id = r.organization_id
    JOIN public.organizations o ON o.id = r.organization_id
   WHERE p.slug = _slug
     AND p.published
     AND o.deleted_at IS NULL
     AND r.status = 'approved'
   ORDER BY r.created_at DESC
   LIMIT 100;
$fn$;

REVOKE ALL ON FUNCTION public.directory_public_reviews(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.directory_public_reviews(text) TO anon, authenticated, service_role;

-- ── What this file establishes ─────────────────────────────────────────────
DO $check$
DECLARE _fn text;
BEGIN
  IF has_table_privilege('anon', 'public.directory_reviews', 'SELECT')
     OR has_table_privilege('authenticated', 'public.directory_reviews', 'SELECT')
     OR has_table_privilege('anon', 'public.directory_reviews', 'INSERT')
     OR has_table_privilege('authenticated', 'public.directory_reviews', 'INSERT')
     OR has_table_privilege('authenticated', 'public.directory_reviews', 'UPDATE') THEN
    RAISE EXCEPTION 'a client role can read or write directory_reviews directly';
  END IF;
  IF has_function_privilege('anon', 'public.submit_directory_review(uuid, integer, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.submit_directory_review(uuid, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a client role can submit a review past the server';
  END IF;
  FOREACH _fn IN ARRAY ARRAY['public.directory_review_queue(text)', 'public.moderate_directory_review(uuid, boolean, text)'] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute %', _fn;
    END IF;
    IF strpos((SELECT prosrc FROM pg_proc WHERE oid = _fn::regprocedure), 'public.is_platform_admin(auth.uid())') = 0 THEN
      RAISE EXCEPTION '% does not ask for a platform admin', _fn;
    END IF;
  END LOOP;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.directory_public_reviews(text)'::regprocedure),
            'r.status = ''approved''') = 0 THEN
    RAISE EXCEPTION 'directory_public_reviews does not filter to approved reviews';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'directory_reviews' AND column_name = 'status')
     IS DISTINCT FROM '''pending''::text' THEN
    RAISE EXCEPTION 'a new review does not start pending';
  END IF;
END
$check$;
