-- The quote rules, proved against a real Postgres rather than read off the
-- migration's text. Run by tests/a-quote-is-answered-once.test.ts, which
-- passes the migration's path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included, so this can be pointed at a shared local stack
-- without leaving a table, a column or a row behind. Each check prints
-- "ok: ..." or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the first
-- failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

BEGIN;

\i :migration

-- ── Fixture: two tenants, an owner and a tech in the first ─────────────────
-- Creating an organization assigns it a plan, which the platform-columns
-- guard only allows from the platform. This is the fixture, not the product.
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-00000000a001', 'owner-a@quotes.proof.invalid'),
  ('a0000000-0000-4000-8000-00000000a002', 'tech-a@quotes.proof.invalid');

INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000000aa', 'Quote Proof A', 'America/Chicago'),
  ('0b000000-0000-4000-8000-0000000000bb', 'Quote Proof B', 'America/Chicago');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-00000000a001', '0a000000-0000-4000-8000-0000000000aa', 'owner'),
  ('a0000000-0000-4000-8000-00000000a002', '0a000000-0000-4000-8000-0000000000aa', 'tech');

INSERT INTO public.clients (id, organization_id, account_type, display_name, primary_email) VALUES
  ('c0000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-0000000000aa', 'residential',
   'Proof Client A', 'client-a@quotes.proof.invalid'),
  ('c0000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-0000000000bb', 'residential',
   'Proof Client B', 'client-b@quotes.proof.invalid');

INSERT INTO public.leads (id, organization_id, name, email, source, status) VALUES
  ('1e000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-0000000000bb',
   'Proof Lead B', 'lead-b@quotes.proof.invalid', 'website', 'new');
SET LOCAL app.allow_protected_org_write = '';

-- Quotes in A: q1 (client, will be accepted), q2 (prospect, will be declined),
-- q3 (client, expired by date), q4 (draft, never sent), q5 (withdrawn).
INSERT INTO public.quotes (id, organization_id, client_id, prospect_name, title, valid_until, number) VALUES
  ('90000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-0000000000aa',
   'c0000000-0000-4000-8000-0000000000a1', NULL, 'Weekly service', current_date + 30, 7),
  ('90000000-0000-4000-8000-000000000002', '0a000000-0000-4000-8000-0000000000aa',
   NULL, 'Oakwood Terrace HOA', 'Common areas', current_date + 30, 7),
  ('90000000-0000-4000-8000-000000000003', '0a000000-0000-4000-8000-0000000000aa',
   'c0000000-0000-4000-8000-0000000000a1', NULL, 'Old offer', current_date - 3, 7),
  ('90000000-0000-4000-8000-000000000004', '0a000000-0000-4000-8000-0000000000aa',
   'c0000000-0000-4000-8000-0000000000a1', NULL, 'Still a draft', current_date + 30, 7),
  ('90000000-0000-4000-8000-000000000005', '0a000000-0000-4000-8000-0000000000aa',
   'c0000000-0000-4000-8000-0000000000a1', NULL, 'Withdrawn', current_date + 30, 7);
INSERT INTO public.quotes (id, organization_id, client_id, title) VALUES
  ('90000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-0000000000bb',
   'c0000000-0000-4000-8000-0000000000b1', 'Tenant B');

INSERT INTO public.quote_line_items (quote_id, description, quantity, unit_amount_cents, amount_cents, recurring, sort) VALUES
  ('90000000-0000-4000-8000-000000000001', 'Initial cleanup', 1, 12000, 12000, false, 0),
  ('90000000-0000-4000-8000-000000000001', 'Weekly visit, two dogs', 1, 2400, 2400, true, 1),
  ('90000000-0000-4000-8000-000000000002', 'Common area stations', 1.5, 333, 500, true, 0);

-- ── Numbering ───────────────────────────────────────────────────────────────
DO $$
DECLARE _a int[]; _b int;
BEGIN
  SELECT array_agg(number ORDER BY number) INTO _a FROM public.quotes
   WHERE organization_id = '0a000000-0000-4000-8000-0000000000aa';
  SELECT number INTO _b FROM public.quotes WHERE id = '90000000-0000-4000-8000-0000000000b1';
  IF _a <> ARRAY[1001, 1002, 1003, 1004, 1005] THEN
    RAISE EXCEPTION 'PROOF FAILED [numbering]: org A got %, and the caller''s 7 must be ignored', _a;
  END IF;
  IF _b <> 1001 THEN
    RAISE EXCEPTION 'PROOF FAILED [numbering]: org B''s first quote is %, not 1001', _b;
  END IF;
  RAISE NOTICE 'ok: numbers come from each organization''s own counter, starting at 1001';
END $$;

-- ── Tenancy of references ───────────────────────────────────────────────────
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    INSERT INTO public.quotes (organization_id, client_id)
    VALUES ('0a000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-0000000000b1');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%not in this organization%' THEN
    RAISE EXCEPTION 'PROOF FAILED [cross-tenant client]: %', COALESCE(_err, 'accepted');
  END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.quotes (organization_id, prospect_name, lead_id)
    VALUES ('0a000000-0000-4000-8000-0000000000aa', 'Somebody', '1e000000-0000-4000-8000-0000000000b1');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%not in this organization%' THEN
    RAISE EXCEPTION 'PROOF FAILED [cross-tenant lead]: %', COALESCE(_err, 'accepted');
  END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.quotes (organization_id) VALUES ('0a000000-0000-4000-8000-0000000000aa');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%quotes_has_a_recipient%' THEN
    RAISE EXCEPTION 'PROOF FAILED [recipient]: %', COALESCE(_err, 'a quote to nobody was accepted');
  END IF;
  RAISE NOTICE 'ok: a quote cannot name another tenant''s client or lead, or nobody at all';
END $$;

-- ── Line arithmetic ─────────────────────────────────────────────────────────
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    INSERT INTO public.quote_line_items (quote_id, description, quantity, unit_amount_cents, amount_cents)
    VALUES ('90000000-0000-4000-8000-000000000004', 'Wrong total', 1.5, 333, 499);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%quote_line_items_amount_is_quantity_times_price%' THEN
    RAISE EXCEPTION 'PROOF FAILED [line total]: 1.5 x 333 stored as 499: %', COALESCE(_err, 'accepted');
  END IF;
  RAISE NOTICE 'ok: a line total is quantity x price rounded half away from zero (1.5 x 333 = 500)';
END $$;

-- ── Send q1, q2, q3 and q5; withdraw q5 ─────────────────────────────────────
UPDATE public.quotes SET status = 'sent', sent_at = now()
 WHERE id IN ('90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002',
              '90000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000005');
UPDATE public.quotes SET status = 'expired' WHERE id = '90000000-0000-4000-8000-000000000005';

-- ── What the link shows ─────────────────────────────────────────────────────
DO $$
DECLARE _t uuid; _doc jsonb;
BEGIN
  SELECT public_token INTO _t FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000004';
  IF public.public_quote_document(_t) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [draft]: a draft''s link returned a document';
  END IF;
  IF public.public_quote_document(gen_random_uuid()) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [unknown token]: returned a document';
  END IF;

  SELECT public_token INTO _t FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000001';
  _doc := public.public_quote_document(_t);
  IF _doc->>'status' <> 'sent' OR jsonb_array_length(_doc->'lines') <> 2
     OR _doc->>'org_name' <> 'Quote Proof A' OR _doc->>'recipient_name' <> 'Proof Client A'
     OR (_doc->'lines'->0->>'description') <> 'Initial cleanup' THEN
    RAISE EXCEPTION 'PROOF FAILED [document]: %', _doc;
  END IF;
  -- Nothing internal leaks through the link: no ids, no emails of the client.
  IF _doc ? 'id' OR _doc ? 'organization_id' OR _doc ? 'client_id' OR _doc::text LIKE '%client-a@%' THEN
    RAISE EXCEPTION 'PROOF FAILED [document leaks]: %', _doc;
  END IF;

  SELECT public_token INTO _t FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000003';
  IF public.public_quote_document(_t)->>'status' <> 'expired' THEN
    RAISE EXCEPTION 'PROOF FAILED [expiry]: a sent quote past valid_until does not read as expired';
  END IF;
  RAISE NOTICE 'ok: the link shows a sent quote, nothing for a draft or a stranger, and expiry by date';
END $$;

-- ── The customer answers ────────────────────────────────────────────────────
DO $$
DECLARE _t uuid; _r1 jsonb; _r2 jsonb; _err text;
BEGIN
  SELECT public_token INTO _t FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000001';

  BEGIN
    PERFORM public.public_quote_respond(_t, true, '  ', NULL);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'signature_required' THEN
    RAISE EXCEPTION 'PROOF FAILED [signature]: a blank name accepted: %', COALESCE(_err, 'accepted');
  END IF;

  _r1 := public.public_quote_respond(_t, true, '  Jane   Q. Customer ', NULL);
  IF _r1->>'status' <> 'accepted' OR (_r1->>'changed')::boolean IS NOT TRUE
     OR _r1->>'accepted_name' <> 'Jane Q. Customer' THEN
    RAISE EXCEPTION 'PROOF FAILED [accept]: %', _r1;
  END IF;

  -- The second tap: the same answer, the same timestamp, no error.
  _r2 := public.public_quote_respond(_t, true, 'Somebody Else', NULL);
  IF (_r2->>'changed')::boolean IS NOT FALSE OR _r2->>'accepted_at' <> _r1->>'accepted_at'
     OR _r2->>'accepted_name' <> 'Jane Q. Customer' THEN
    RAISE EXCEPTION 'PROOF FAILED [idempotent accept]: first %, second %', _r1, _r2;
  END IF;

  _err := NULL;
  BEGIN
    PERFORM public.public_quote_respond(_t, false, NULL, 'changed my mind');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'quote_already_accepted' THEN
    RAISE EXCEPTION 'PROOF FAILED [decline after accept]: %', COALESCE(_err, 'accepted');
  END IF;
  RAISE NOTICE 'ok: accept needs a typed name, happens once, and a second tap returns the first answer';
END $$;

DO $$
DECLARE _t uuid; _r jsonb; _err text;
BEGIN
  SELECT public_token INTO _t FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000002';
  _r := public.public_quote_respond(_t, false, NULL, '  Over budget this year  ');
  IF _r->>'status' <> 'declined' OR _r->>'decline_reason' <> 'Over budget this year' THEN
    RAISE EXCEPTION 'PROOF FAILED [decline]: %', _r;
  END IF;
  _r := public.public_quote_respond(_t, false, NULL, NULL);
  IF (_r->>'changed')::boolean IS NOT FALSE OR _r->>'decline_reason' <> 'Over budget this year' THEN
    RAISE EXCEPTION 'PROOF FAILED [idempotent decline]: %', _r;
  END IF;
  BEGIN
    PERFORM public.public_quote_respond(_t, true, 'Board President', NULL);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'quote_already_declined' THEN
    RAISE EXCEPTION 'PROOF FAILED [accept after decline]: %', COALESCE(_err, 'accepted');
  END IF;
  RAISE NOTICE 'ok: decline keeps its reason, is idempotent, and cannot be turned into an accept';
END $$;

DO $$
DECLARE _t uuid; _err text; _id uuid;
BEGIN
  FOREACH _id IN ARRAY ARRAY['90000000-0000-4000-8000-000000000003'::uuid,
                             '90000000-0000-4000-8000-000000000005'::uuid] LOOP
    SELECT public_token INTO _t FROM public.quotes WHERE id = _id;
    _err := NULL;
    BEGIN
      PERFORM public.public_quote_respond(_t, true, 'Jane Customer', NULL);
    EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
    END;
    IF _err IS DISTINCT FROM 'quote_expired' THEN
      RAISE EXCEPTION 'PROOF FAILED [expired %]: %', _id, COALESCE(_err, 'accepted');
    END IF;
  END LOOP;

  SELECT public_token INTO _t FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000004';
  _err := NULL;
  BEGIN
    PERFORM public.public_quote_respond(_t, true, 'Jane Customer', NULL);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'quote_not_found' THEN
    RAISE EXCEPTION 'PROOF FAILED [draft answered]: %', COALESCE(_err, 'accepted');
  END IF;
  _err := NULL;
  BEGIN
    PERFORM public.public_quote_respond(gen_random_uuid(), true, 'Jane Customer', NULL);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'quote_not_found' THEN
    RAISE EXCEPTION 'PROOF FAILED [unknown token answered]: %', COALESCE(_err, 'accepted');
  END IF;
  RAISE NOTICE 'ok: an expired, withdrawn, draft or unknown quote cannot be accepted';
END $$;

-- ── anon: no table, no function ─────────────────────────────────────────────
SET ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM 1 FROM public.quotes LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can SELECT quotes'; END IF;
  _err := NULL;
  BEGIN
    PERFORM 1 FROM public.quote_line_items LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can SELECT quote_line_items'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.public_quote_document(gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can call public_quote_document'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.public_quote_respond(gen_random_uuid(), true, 'x', NULL);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can call public_quote_respond'; END IF;
  RAISE NOTICE 'ok: anon can read neither table and call neither public function';
END $$;
RESET ROLE;

-- ── The office, through RLS ─────────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000a001","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _n int; _err text; _tok uuid; _tok2 uuid;
BEGIN
  SELECT count(*) INTO _n FROM public.quotes;
  IF _n <> 5 THEN
    RAISE EXCEPTION 'PROOF FAILED [owner reads]: the owner of A sees % quotes, expected A''s 5', _n;
  END IF;

  _err := NULL;
  BEGIN
    PERFORM public.public_quote_document(gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [authenticated]: a signed-in user can call public_quote_document';
  END IF;

  -- Marking your own quote accepted is not the customer accepting it.
  _err := NULL;
  BEGIN
    UPDATE public.quotes SET status = 'accepted', accepted_at = now(), accepted_name = 'The Owner'
     WHERE id = '90000000-0000-4000-8000-000000000003';
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE 'Only the customer can accept%' THEN
    RAISE EXCEPTION 'PROOF FAILED [forged accept]: %', COALESCE(_err, 'the office accepted its own quote');
  END IF;

  -- What was sent stays as sent.
  _err := NULL;
  BEGIN
    UPDATE public.quotes SET title = 'Cheaper now' WHERE id = '90000000-0000-4000-8000-000000000003';
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE 'A quote cannot be edited once it has been sent%' THEN
    RAISE EXCEPTION 'PROOF FAILED [frozen content]: %', COALESCE(_err, 'a sent quote was edited');
  END IF;

  _err := NULL;
  BEGIN
    INSERT INTO public.quote_line_items (quote_id, description, quantity, unit_amount_cents, amount_cents)
    VALUES ('90000000-0000-4000-8000-000000000003', 'Sneaked in', 1, 100, 100);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [frozen lines]: a line was added to a sent quote';
  END IF;

  DELETE FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000003';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [delete]: a sent quote was deleted'; END IF;

  -- The link never changes, whatever is written.
  SELECT public_token INTO _tok FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000004';
  UPDATE public.quotes SET public_token = gen_random_uuid(), number = 1, title = 'Renamed draft'
   WHERE id = '90000000-0000-4000-8000-000000000004';
  SELECT public_token INTO _tok2 FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000004';
  IF _tok2 <> _tok OR (SELECT number FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000004') <> 1004 THEN
    RAISE EXCEPTION 'PROOF FAILED [identity]: the token or number of a quote changed';
  END IF;

  -- A draft IS the office's to edit, lines and all, and to delete.
  INSERT INTO public.quote_line_items (quote_id, description, quantity, unit_amount_cents, amount_cents)
  VALUES ('90000000-0000-4000-8000-000000000004', 'Deodoriser', 2, 750, 1500);
  DELETE FROM public.quotes WHERE id = '90000000-0000-4000-8000-000000000004';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [draft delete]: the owner could not delete a draft'; END IF;

  RAISE NOTICE 'ok: the office reads its own quotes, edits drafts, and cannot forge, rewrite or delete a sent one';
END $$;
RESET ROLE;

-- A technician in the same org holds no billing permission.
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-00000000a002","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.quotes;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [tech reads]: a technician sees % quotes', _n; END IF;
  SELECT count(*) INTO _n FROM public.quote_line_items;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [tech reads]: a technician sees % quote lines', _n; END IF;
  RAISE NOTICE 'ok: a technician in the same organization sees no quotes and no lines';
END $$;
RESET ROLE;

\echo ALL QUOTE PROOFS PASSED
ROLLBACK;
