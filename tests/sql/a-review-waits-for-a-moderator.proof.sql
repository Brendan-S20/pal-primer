-- A review is public only after a moderator approves it (#630), proved
-- against a real Postgres. Run by tests/a-review-waits-for-a-moderator.test.ts
-- with :profiles (20261110120000) and :migration (20261110120100), and by
-- CI's database job through
-- supabase/proofs/20261110120100-a-review-waits-for-a-moderator.sql with
-- neither (the database was just built from every migration).
-- One transaction, ROLLED BACK at the end. Each check prints "ok: ..." or
-- raises "PROOF FAILED [...]".
--
-- One listed business, A, with four clients: R1 and R3 have a paid invoice,
-- R2 has only an open one, R4 is a client whose email is A's owner's. One
-- unlisted business, U, whose client has paid. A platform admin (the
-- moderator) and A's owner.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\if :{?profiles}
\i :profiles
\endif
\if :{?migration}
\i :migration
\endif

-- ── Fixture ─────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true) \gset
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f6310000-0000-4000-8000-000000000a01', 'owner-a@review.proof.invalid'),
  ('f6310000-0000-4000-8000-000000000f01', 'moderator@review.proof.invalid');
INSERT INTO public.organizations (id, name, timezone, service_lines) VALUES
  ('06310000-0000-4000-8000-0000000000aa', 'Review Proof A', 'UTC', '{pet_waste}'),
  ('06310000-0000-4000-8000-0000000000ee', 'Review Proof U', 'UTC', '{pet_waste}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f6310000-0000-4000-8000-000000000a01', '06310000-0000-4000-8000-0000000000aa', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('56310000-0000-4000-8000-0000000000a1', '06310000-0000-4000-8000-0000000000aa',
   'f6310000-0000-4000-8000-000000000a01', 'owner', 'Owner A', true);
INSERT INTO public.platform_admins (user_id) VALUES ('f6310000-0000-4000-8000-000000000f01');

-- A's published profile, written as the table owner (the profile's own
-- rules are 20261110120000's proof; this one is about reviews).
INSERT INTO public.directory_profiles (organization_id, slug, published, display_name, coverage_zips, service_lines, published_at) VALUES
  ('06310000-0000-4000-8000-0000000000aa', 'review-proof-a', true, 'Review Proof A', ARRAY['48201'], ARRAY['pet_waste'], now());

INSERT INTO public.clients (id, organization_id, account_type, display_name, primary_email) VALUES
  ('c6310000-0000-4000-8000-0000000000a1', '06310000-0000-4000-8000-0000000000aa', 'residential', 'Review Secret One', 'one@review.proof.invalid'),
  ('c6310000-0000-4000-8000-0000000000a2', '06310000-0000-4000-8000-0000000000aa', 'residential', 'Review Secret Two', 'two@review.proof.invalid'),
  ('c6310000-0000-4000-8000-0000000000a3', '06310000-0000-4000-8000-0000000000aa', 'residential', 'Review Secret Three', 'three@review.proof.invalid'),
  ('c6310000-0000-4000-8000-0000000000a4', '06310000-0000-4000-8000-0000000000aa', 'residential', 'Review Owner As Client', 'OWNER-A@review.proof.invalid'),
  ('c6310000-0000-4000-8000-0000000000e1', '06310000-0000-4000-8000-0000000000ee', 'residential', 'Review Unlisted', 'u@review.proof.invalid');
INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status, issued_at) VALUES
  ('16310000-0000-4000-8000-0000000000a1', '06310000-0000-4000-8000-0000000000aa', 'c6310000-0000-4000-8000-0000000000a1', current_date - 30, 2000, 'paid', now() - interval '30 days'),
  ('16310000-0000-4000-8000-0000000000a2', '06310000-0000-4000-8000-0000000000aa', 'c6310000-0000-4000-8000-0000000000a2', current_date - 30, 2000, 'open', now() - interval '30 days'),
  ('16310000-0000-4000-8000-0000000000a3', '06310000-0000-4000-8000-0000000000aa', 'c6310000-0000-4000-8000-0000000000a3', current_date - 30, 2000, 'paid', now() - interval '30 days'),
  ('16310000-0000-4000-8000-0000000000a4', '06310000-0000-4000-8000-0000000000aa', 'c6310000-0000-4000-8000-0000000000a4', current_date - 30, 2000, 'paid', now() - interval '30 days'),
  ('16310000-0000-4000-8000-0000000000e1', '06310000-0000-4000-8000-0000000000ee', 'c6310000-0000-4000-8000-0000000000e1', current_date - 30, 2000, 'paid', now() - interval '30 days');

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(text) TO authenticated;
CREATE FUNCTION pg_temp.public_count() RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.directory_public_reviews('review-proof-a');
$$;
GRANT EXECUTE ON FUNCTION pg_temp.public_count() TO anon, authenticated;

-- ── 1. Who may submit (the server, for an eligible client) ────────────────
SET LOCAL ROLE service_role;
DO $$
DECLARE _err text; _id uuid;
BEGIN
  SELECT public.submit_directory_review('c6310000-0000-4000-8000-0000000000a1', 5, 'Always on time.') INTO _id;
  PERFORM set_config('app.r1', _id::text, true);
  SELECT public.submit_directory_review('c6310000-0000-4000-8000-0000000000a3', 1, 'Spam spam spam.') INTO _id;
  PERFORM set_config('app.r3', _id::text, true);

  BEGIN PERFORM public.submit_directory_review('c6310000-0000-4000-8000-0000000000a2', 4, 'Only an open bill.');
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [eligible]: a client with no paid invoice or completed visit reviewed'; END IF;
  _err := NULL;
  BEGIN PERFORM public.submit_directory_review('c6310000-0000-4000-8000-0000000000a4', 5, 'Best business ever.');
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [staff]: the owner reviewed their own business'; END IF;
  _err := NULL;
  BEGIN PERFORM public.submit_directory_review('c6310000-0000-4000-8000-0000000000e1', 5, 'Not listed.');
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [listed]: a review was taken for a business not in the directory'; END IF;
  RAISE NOTICE 'ok: the server takes a review from a client with a paid invoice, and refuses one with only an open bill, the owner as a client, and an unlisted business';
END $$;
RESET ROLE;

-- ── 2. A NEW REVIEW IS NOT VISIBLE PUBLICLY ───────────────────────────────
SET LOCAL ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  IF pg_temp.public_count() <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [pending]: anon reads % reviews before any was approved', pg_temp.public_count();
  END IF;
  BEGIN PERFORM 1 FROM public.directory_reviews; EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon reads directory_reviews directly'; END IF;
  _err := NULL;
  BEGIN PERFORM * FROM public.directory_review_queue('pending'); EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: anon reads the moderation queue'; END IF;
  RAISE NOTICE 'ok: a new review is not visible publicly, and anon reads neither the table nor the queue';
END $$;
RESET ROLE;

-- ── 3. Only a platform admin moderates; the business cannot ──────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f6310000-0000-4000-8000-000000000a01') \gset
DO $$
DECLARE _err text;
BEGIN
  BEGIN PERFORM public.moderate_directory_review(current_setting('app.r1')::uuid, true);
  EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [moderator]: the business''s own owner approved a review'; END IF;
  _err := NULL;
  BEGIN PERFORM * FROM public.directory_review_queue('pending'); EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [moderator]: the business''s owner reads the queue'; END IF;
  _err := NULL;
  BEGIN PERFORM 1 FROM public.directory_reviews; EXCEPTION WHEN insufficient_privilege THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [door]: the business reads its pending reviews'; END IF;
  RAISE NOTICE 'ok: the business''s owner can neither moderate, read the queue, nor read the reviews table';
END $$;

-- ── 4. IT BECOMES VISIBLE ONLY AFTER APPROVAL; A REJECTED ONE NEVER SHOWS ──
SELECT pg_temp.as_user('f6310000-0000-4000-8000-000000000f01') \gset
DO $$
DECLARE _n int; _err text;
BEGIN
  SELECT count(*) INTO _n FROM public.directory_review_queue('pending');
  IF _n < 2 THEN RAISE EXCEPTION 'PROOF FAILED [queue]: the moderator sees % pending reviews (want both)', _n; END IF;
  -- A rejection has to name a written rule.
  BEGIN PERFORM public.moderate_directory_review(current_setting('app.r3')::uuid, false, 'too negative');
  EXCEPTION WHEN invalid_parameter_value THEN _err := 'x'; END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [rules]: a review was rejected for a reason outside the written rules'; END IF;
  PERFORM public.moderate_directory_review(current_setting('app.r1')::uuid, true);
  PERFORM public.moderate_directory_review(current_setting('app.r3')::uuid, false, 'believed_fake');
  RAISE NOTICE 'ok: the platform admin reads the queue, approves one, and rejects one under a written rule (an unwritten one is refused)';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true) \gset

SET LOCAL ROLE anon;
DO $$
DECLARE _r record; _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.directory_public_reviews('review-proof-a');
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [approved]: anon reads % reviews after one approval and one rejection (want 1)', _n; END IF;
  SELECT * INTO _r FROM public.directory_public_reviews('review-proof-a');
  IF _r.rating <> 5 OR _r.body <> 'Always on time.' THEN
    RAISE EXCEPTION 'PROOF FAILED [approved]: anon reads %', row_to_json(_r);
  END IF;
  IF EXISTS (SELECT 1 FROM public.directory_public_reviews('review-proof-a') t WHERE t.body LIKE 'Spam%') THEN
    RAISE EXCEPTION 'PROOF FAILED [rejected]: a rejected review is public';
  END IF;
  IF (SELECT string_agg(to_jsonb(t)::text, '') FROM public.directory_public_reviews('review-proof-a') t)
       ~ '(Review Secret|c6310000|one@review|client_id)' THEN
    RAISE EXCEPTION 'PROOF FAILED [columns]: a public review carries who wrote it';
  END IF;
  RAISE NOTICE 'ok: the approved review is visible, the rejected one is not, and neither says who wrote it';
END $$;
RESET ROLE;

-- ── 5. An edit goes back to the queue; a rejected review stays hidden ─────
SET LOCAL ROLE service_role;
DO $$
DECLARE _id uuid; _n int;
BEGIN
  -- R1 edits its approved review: same row, and pending again.
  SELECT public.submit_directory_review('c6310000-0000-4000-8000-0000000000a1', 2, 'Missed a week.') INTO _id;
  IF _id <> current_setting('app.r1')::uuid THEN RAISE EXCEPTION 'PROOF FAILED [one per client]: an edit made a second review'; END IF;
  SELECT count(*) INTO _n FROM public.directory_reviews WHERE organization_id = '06310000-0000-4000-8000-0000000000aa' AND client_id = 'c6310000-0000-4000-8000-0000000000a1';
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [one per client]: client R1 has % reviews', _n; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF pg_temp.public_count() <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [edit]: an edited review stayed public before a moderator saw the edit';
  END IF;
  RAISE NOTICE 'ok: one review per client, an edit is the same review, and it is hidden again until a moderator approves the edit; the rejected review never showed';
END $$;
RESET ROLE;

-- ── 6. Mutation: without the approved filter, a pending review leaks ──────
CREATE OR REPLACE FUNCTION public.directory_public_reviews(_slug text)
 RETURNS TABLE (rating smallint, body text, reviewed_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT r.rating, r.body, r.created_at
    FROM public.directory_reviews r
    JOIN public.directory_profiles p ON p.organization_id = r.organization_id
   WHERE p.slug = _slug AND p.published;
$fn$;
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF pg_temp.public_count() = 0 THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: with the approved filter removed anon still reads no reviews';
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: without r.status = ''approved'' anon reads pending and rejected reviews, so that filter is what holds them back';
END $$;
RESET ROLE;

\echo ALL REVIEW MODERATION PROOFS PASSED
ROLLBACK;
