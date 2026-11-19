-- Proof for 20261118010000: a directory profile may publish a contact email
-- and phone (#969). Run by tests/a-directory-profile-can-publish-a-contact.test.ts
-- with :migration, and by supabase/proofs/20261118010000-*.sql with none.
-- One transaction, ROLLED BACK. Each check prints "ok: ..." or "PROOF FAILED".
\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;
BEGIN;

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone, service_lines, contact_email, contact_phone)
SELECT ('09690000-0000-4000-8000-0000000000' || k)::uuid, 'Contact Proof ' || k || ' (TEST)', 'UTC', '{dog_walking}',
       'account-' || k || '@contact.proof.invalid', '+13135550969'
  FROM unnest(ARRAY['aa', 'bb']) k;
SET LOCAL app.allow_protected_org_write = '';

-- E: a profile that exists BEFORE the migration (when applied here).
INSERT INTO public.directory_profiles (organization_id, slug, published, display_name, coverage_zips, service_lines, published_at)
VALUES ('09690000-0000-4000-8000-0000000000aa', 'contact-proof-aa', true, 'Contact Proof aa (TEST)', ARRAY['48201'], ARRAY['dog_walking'], now()),
       ('09690000-0000-4000-8000-0000000000bb', 'contact-proof-bb', false, 'Contact Proof bb (TEST)', ARRAY['48201'], ARRAY['dog_walking'], now());

\if :{?migration}
\i :migration
\endif

CREATE FUNCTION pg_temp.refused(_label text, _sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _got text;
BEGIN
  BEGIN EXECUTE _sql; EXCEPTION WHEN OTHERS THEN _got := SQLSTATE; END;
  IF _got IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [%]: it was allowed', _label;
  ELSIF _got <> '23514' THEN RAISE EXCEPTION 'PROOF FAILED [%]: refused with % (want 23514)', _label, _got; END IF;
END $$;

DO $p$
DECLARE _e text; _ph text; _n int;
BEGIN
  -- Existing rows came through with NULL, and the view shows NULL.
  SELECT public_email, public_phone INTO _e, _ph FROM public.directory_public_listings WHERE slug = 'contact-proof-aa';
  IF _e IS NOT NULL OR _ph IS NOT NULL THEN RAISE EXCEPTION 'PROOF FAILED [default]: % %', _e, _ph; END IF;
  RAISE NOTICE 'ok: an existing profile publishes no contact until its owner chooses one';

  -- Good shapes are accepted.
  FOREACH _ph IN ARRAY ARRAY['+13135550100', '3135550100', '+442071234567'] LOOP
    UPDATE public.directory_profiles SET public_phone = _ph WHERE slug = 'contact-proof-aa';
  END LOOP;
  UPDATE public.directory_profiles SET public_email = 'Hello@Pet-Pro.example.com', public_phone = '+13135550100' WHERE slug = 'contact-proof-aa';
  RAISE NOTICE 'ok: an address, an E.164 phone and a digits-only phone are accepted';

  -- Bad shapes are refused (check_violation).
  PERFORM pg_temp.refused('email: no @', $q$UPDATE public.directory_profiles SET public_email = 'nobody.example.com' WHERE slug = 'contact-proof-aa'$q$);
  PERFORM pg_temp.refused('email: two @', $q$UPDATE public.directory_profiles SET public_email = 'a@b@c.example' WHERE slug = 'contact-proof-aa'$q$);
  PERFORM pg_temp.refused('email: space', $q$UPDATE public.directory_profiles SET public_email = 'a b@example.com' WHERE slug = 'contact-proof-aa'$q$);
  PERFORM pg_temp.refused('email: no dot in domain', $q$UPDATE public.directory_profiles SET public_email = 'a@localhost' WHERE slug = 'contact-proof-aa'$q$);
  PERFORM pg_temp.refused('email: empty', $q$UPDATE public.directory_profiles SET public_email = '' WHERE slug = 'contact-proof-aa'$q$);
  PERFORM pg_temp.refused('email: 255 chars', format($q$UPDATE public.directory_profiles SET public_email = %L WHERE slug = 'contact-proof-aa'$q$, repeat('a', 245) || '@ex.example'));
  PERFORM pg_temp.refused('phone: letters', $q$UPDATE public.directory_profiles SET public_phone = '313-CALL-NOW' WHERE slug = 'contact-proof-aa'$q$);
  PERFORM pg_temp.refused('phone: punctuation', $q$UPDATE public.directory_profiles SET public_phone = '(313) 555-0100' WHERE slug = 'contact-proof-aa'$q$);
  PERFORM pg_temp.refused('phone: + then 0', $q$UPDATE public.directory_profiles SET public_phone = '+0313555010' WHERE slug = 'contact-proof-aa'$q$);
  PERFORM pg_temp.refused('phone: too short', $q$UPDATE public.directory_profiles SET public_phone = '12345' WHERE slug = 'contact-proof-aa'$q$);
  PERFORM pg_temp.refused('phone: too long', $q$UPDATE public.directory_profiles SET public_phone = '+1234567890123456' WHERE slug = 'contact-proof-aa'$q$);
  RAISE NOTICE 'ok: malformed emails and phones are refused with check_violation';

  -- Published shows the contact; unpublished does not appear at all; the
  -- account's own contact never reaches the view.
  SELECT public_email, public_phone INTO _e, _ph FROM public.directory_public_listings WHERE slug = 'contact-proof-aa';
  IF _e IS DISTINCT FROM 'Hello@Pet-Pro.example.com' OR _ph IS DISTINCT FROM '+13135550100' THEN
    RAISE EXCEPTION 'PROOF FAILED [view]: % %', _e, _ph; END IF;
  UPDATE public.directory_profiles SET public_email = 'hidden@draft.example' WHERE slug = 'contact-proof-bb';
  SELECT count(*) INTO _n FROM public.directory_public_listings WHERE slug = 'contact-proof-bb' OR public_email LIKE 'account-%' OR public_phone = '+13135550969';
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [leak]: % rows', _n; END IF;
  RAISE NOTICE 'ok: the view shows a published profile''s chosen contact; an unpublished one and the account contact never appear';

  -- A visitor reads the view but not the column on the table.
  IF has_column_privilege('anon', 'public.directory_profiles', 'public_email', 'SELECT')
     OR NOT has_table_privilege('anon', 'public.directory_public_listings', 'SELECT') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]'; END IF;
  RAISE NOTICE 'ok: anon reads the view, not the table column';
END
$p$;

-- Mutation: without the CHECK the bad value goes in, so the refusals above are the CHECK's doing.
SAVEPOINT before_mutation;
ALTER TABLE public.directory_profiles DROP CONSTRAINT directory_profiles_public_email_check;
DO $m$
BEGIN
  UPDATE public.directory_profiles SET public_email = 'nobody.example.com' WHERE slug = 'contact-proof-aa';
  RAISE NOTICE 'ok: mutation reproduces: without the CHECK a malformed email is stored';
END $m$;
ROLLBACK TO SAVEPOINT before_mutation;

ROLLBACK;
