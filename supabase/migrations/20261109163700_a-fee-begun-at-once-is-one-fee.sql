-- A fee begun at once is one fee, and no error (#733, found in #730's code).
--
-- NEEDS BRENDAN'S OK before it is applied anywhere. Proposed file only.
--
-- ── THE FAULT ────────────────────────────────────────────────────────────
--
-- begin_portal_change_fee (20261108153700) inserts the fee row with
--
--   ON CONFLICT (request_id) DO NOTHING
--
-- but portal_change_fee_charges has two unique constraints that always clash
-- together: request_id, and idempotency_key, which is
-- 'portal-change-fee:' || request_id. Naming one arbiter makes only that
-- index "check, back out on conflict". Postgres checks every other unique
-- index the plain way: wait for the other inserter, then raise if it
-- committed. So when two calls for one request pass the pre-check at the same
-- instant, the loser does not quietly do nothing: it fails with
--
--   23505 duplicate key value violates unique constraint
--         "portal_change_fee_charges_idempotency_key_key"
--
-- The data was never wrong (one row, one created: true); a caller got an
-- error instead of the existing fee. Seen in CI's database job on #733
-- (job 129040645647, a-portal-change-is-made-once.db.test.ts, six begins at
-- once). Reproduced on Postgres 16 with the function body verbatim and six
-- sessions released together by a barrier: 9 of 240 and 17 of 240 calls
-- failed; with the change below, 0 of 480.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────
--
-- The same function, with one line changed: ON CONFLICT DO NOTHING, no
-- target, so every unique index is an arbiter and either clash means "already
-- there". That is the same rule, because both keys name the same request: a
-- clash on idempotency_key can only be this request's own fee row, which the
-- existing fallback SELECT then returns. Nothing else in the body, the
-- signature, the grants or the table changes. 20261108153700 is applied to
-- production and is not edited; this file redefines the function after it.
--
-- Replays into an empty database: the function and table exist by this point
-- (20261108153700), nothing reads or writes rows, and the check reads the
-- catalog for this one named function.

CREATE OR REPLACE FUNCTION public.begin_portal_change_fee(_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _r public.portal_change_requests%ROWTYPE; _c public.portal_change_fee_charges%ROWTYPE; _new boolean := false;
BEGIN
  SELECT * INTO _r FROM public.portal_change_requests WHERE id = _request_id;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF _r.status NOT IN ('applied', 'approved') THEN
    RAISE EXCEPTION 'Only an applied or approved change carries a fee';
  END IF;
  IF _r.fee_cents <= 0 THEN
    RETURN jsonb_build_object('charge', NULL, 'created', false);
  END IF;

  INSERT INTO public.portal_change_fee_charges (organization_id, client_id, request_id, amount_cents, idempotency_key)
  VALUES (_r.organization_id, _r.client_id, _r.id, _r.fee_cents, 'portal-change-fee:' || _r.id::text)
  ON CONFLICT DO NOTHING
  RETURNING * INTO _c;
  IF _c.id IS NOT NULL THEN
    _new := true;
  ELSE
    SELECT * INTO _c FROM public.portal_change_fee_charges WHERE request_id = _r.id;
  END IF;
  RETURN jsonb_build_object('charge', to_jsonb(_c), 'created', _new);
END;
$function$;

-- CREATE OR REPLACE keeps the grants; restated as 20261108153700 has them.
REVOKE ALL ON FUNCTION public.begin_portal_change_fee(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_portal_change_fee(uuid) TO service_role;

DO $check$
DECLARE
  _fn constant regprocedure := 'public.begin_portal_change_fee(uuid)'::regprocedure;
  _src text;
BEGIN
  SELECT p.prosrc INTO _src FROM pg_proc p WHERE p.oid = _fn;
  IF strpos(_src, 'ON CONFLICT DO NOTHING') = 0 OR strpos(_src, 'ON CONFLICT (request_id)') > 0 THEN
    RAISE EXCEPTION 'begin_portal_change_fee must insert with an untargeted ON CONFLICT DO NOTHING';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = _fn) THEN
    RAISE EXCEPTION 'begin_portal_change_fee must stay SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE')
    OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'begin_portal_change_fee must stay service-role only';
  END IF;
END
$check$;
