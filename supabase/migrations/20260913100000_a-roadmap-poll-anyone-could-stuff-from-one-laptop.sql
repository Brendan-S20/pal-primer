-- The roadmap poll on the marketing site was an unauthenticated write with no
-- ceiling on it.
--
-- `cast_roadmap_vote` is SECURITY DEFINER and granted to `anon`, which is
-- correct: the poll is meant to work for a stranger who has never signed in.
-- What it checked was the SHAPE of its two arguments and nothing else —
-- `p_feature` had to look like a slug and `p_voter` had to look like an id, and
-- both came from the caller. `UNIQUE (feature, voter_id)` then made one vote per
-- pair, which reads like a guard and is not one: the caller picks both halves of
-- the pair, so a loop that increments `p_voter` votes as many times as it likes,
-- and a loop that increments `p_feature` writes rows for features that do not
-- exist. That is a free, unmetered INSERT into a production table by anybody who
-- can read the page source — and the page source is where the publishable key
-- and the two RPC names are, because that is how the poll works.
--
-- Nothing has been stuffed. The table holds 2 rows, cast on 2026-07-14 and
-- 2026-08-14. That is a measurement of today and not a property of the design,
-- which is the reason this file exists.
--
-- The fix is a per-address rate limit, applied inside the function, because that
-- is the one thing about the caller that is not caller-supplied.
--
--   Cloudflare sits in front of this project. It sets `cf-connecting-ip` from
--   the TCP peer and overwrites whatever the client sent under that name, so it
--   is the trustworthy key. `x-forwarded-for` is the fallback, and this reads
--   the LAST comma-segment of it rather than the first: a client may prepend its
--   own list and Cloudflare appends the real address to the end, so the caller
--   controls the front of that header and not the back. Taking the first segment
--   — which is the usual way to read XFF, and is right behind a proxy you own —
--   would have made the limit opt-out by sending one extra header.
--
--   Checked against the live gateway on 2026-09-13: both headers are present on
--   an RPC call and agree.
--
-- The address is hashed before it is stored. The page promises the poll is
-- anonymous, and a table of who-voted-from-where would make that false. This is
-- a salted SHA-256 with the salt in this file, so it is not proof against
-- someone with both this source and table read access enumerating the IPv4
-- space; it is proof against the table itself being a list of addresses, and the
-- row is deleted an hour after it is written. Saying which of those it is, here,
-- rather than calling it "hashed" and leaving it.
--
-- 60 votes per address per hour. A real visitor can cast at most 11 — the
-- roadmap has 11 items and the button is one-way — so the cap is not aimed at
-- them. It is set where a shared office or cafe address with several people on
-- it still fits, and it turns "unbounded" into 1,440 rows per address per day,
-- which is a number somebody can notice.
--
-- `roadmap_vote_counts` gets a LIMIT for the same reason. It returned one row
-- per distinct feature ever written, unbounded, to every visitor loading the
-- page; junk slugs would have made the public poll's own payload the second
-- symptom. 100 is eight times the real roadmap.

-- ---------------------------------------------------------------------------
-- The counter.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.roadmap_vote_throttle (
  ip_hash           text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  votes             integer NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.roadmap_vote_throttle IS
  'Fixed one-hour vote counter for cast_roadmap_vote, keyed by a salted hash of the '
  'client address. Deny-all: reached only by cast_roadmap_vote, which is SECURITY DEFINER. '
  'Rows are pruned an hour after the window opens.';

ALTER TABLE public.roadmap_vote_throttle ENABLE ROW LEVEL SECURITY;

-- No policies, on purpose. See docs/security-advisor-triage.md §4.

CREATE INDEX IF NOT EXISTS roadmap_vote_throttle_window_idx
  ON public.roadmap_vote_throttle (window_started_at);

-- ---------------------------------------------------------------------------
-- The vote.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cast_roadmap_vote(p_feature text, p_voter text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _headers jsonb;
  _ip      text;
  _hash    text;
  _votes   integer;
BEGIN
  IF p_feature IS NULL OR p_feature !~ '^[a-z0-9-]{3,40}$' THEN
    RAISE EXCEPTION 'invalid feature';
  END IF;
  IF p_voter IS NULL OR p_voter !~ '^[a-zA-Z0-9-]{8,64}$' THEN
    RAISE EXCEPTION 'invalid voter';
  END IF;

  _headers := nullif(current_setting('request.headers', true), '')::jsonb;

  -- cf-connecting-ip first: Cloudflare overwrites it, so the caller cannot set
  -- it. The x-forwarded-for fallback takes the last segment, because the caller
  -- controls the front of that list and Cloudflare appends to the back.
  _ip := coalesce(
    nullif(btrim(coalesce(_headers ->> 'cf-connecting-ip', '')), ''),
    nullif(btrim(regexp_replace(coalesce(_headers ->> 'x-forwarded-for', ''), '^.*,', '')), '')
  );

  -- No headers at all means this is not a PostgREST request — a migration, a
  -- psql session, a scheduled job. There is no address to meter and nothing
  -- anonymous about the caller, so the vote goes through unmetered.
  IF _ip IS NOT NULL THEN
    _hash := encode(sha256(convert_to('houndstack-roadmap-throttle:v1:' || _ip, 'UTF8')), 'hex');

    -- Bounded prune of OTHER addresses, so a busy hour cannot turn this into a
    -- full-table DELETE. It deliberately leaves this caller's own row alone:
    -- prune and reset share one condition, so a prune that took this row too
    -- would make the reset below unreachable — two mechanisms doing one job,
    -- with the one that is actually load-bearing never exercised by any test.
    -- Expiring the row is the ON CONFLICT branch's job and only its job.
    DELETE FROM public.roadmap_vote_throttle
     WHERE ctid IN (
       SELECT ctid FROM public.roadmap_vote_throttle
        WHERE window_started_at < now() - interval '1 hour'
          AND ip_hash <> _hash
        LIMIT 200
     );

    INSERT INTO public.roadmap_vote_throttle AS t (ip_hash, window_started_at, votes)
    VALUES (_hash, now(), 1)
    ON CONFLICT (ip_hash) DO UPDATE
       SET votes = CASE WHEN t.window_started_at < now() - interval '1 hour'
                        THEN 1 ELSE t.votes + 1 END,
           window_started_at = CASE WHEN t.window_started_at < now() - interval '1 hour'
                        THEN now() ELSE t.window_started_at END
    RETURNING t.votes INTO _votes;

    -- The RAISE rolls this statement back with the rest of the transaction, so
    -- the stored count stops at the cap rather than climbing past it. That is
    -- the behaviour we want and not an accident: every later call in the window
    -- re-reaches the cap and is refused the same way.
    IF _votes > 60 THEN
      RAISE EXCEPTION 'too many votes from this address, try again later';
    END IF;
  END IF;

  INSERT INTO public.roadmap_votes (feature, voter_id)
  VALUES (p_feature, p_voter)
  ON CONFLICT (feature, voter_id) DO NOTHING;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cast_roadmap_vote(text, text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- The count.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.roadmap_vote_counts()
RETURNS TABLE(feature text, votes bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT feature, count(*)::bigint AS votes
    FROM public.roadmap_votes
   GROUP BY feature
   ORDER BY count(*) DESC, feature
   LIMIT 100;
$function$;

GRANT EXECUTE ON FUNCTION public.roadmap_vote_counts() TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- What this establishes. Provable from an empty database, so these are
-- exceptions rather than warnings.
-- ---------------------------------------------------------------------------

DO $est$
DECLARE
  _src     text;
  _blocked boolean;
  _landed  integer;
  _hash    text;
  _other   text;
  _front   text;
  _back    text;
BEGIN
  IF to_regclass('public.roadmap_vote_throttle') IS NULL THEN
    RAISE EXCEPTION 'roadmap_vote_throttle does not exist';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.roadmap_vote_throttle'::regclass) THEN
    RAISE EXCEPTION 'roadmap_vote_throttle has RLS disabled; it holds address hashes';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'roadmap_vote_throttle') THEN
    RAISE EXCEPTION 'roadmap_vote_throttle has a policy; it is deny-all on purpose';
  END IF;

  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'cast_roadmap_vote';

  IF _src IS NULL OR _src NOT LIKE '%roadmap_vote_throttle%' THEN
    RAISE EXCEPTION 'cast_roadmap_vote does not consult the throttle';
  END IF;
  IF _src NOT LIKE '%cf-connecting-ip%' THEN
    RAISE EXCEPTION 'cast_roadmap_vote does not read the address Cloudflare vouches for';
  END IF;

  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'roadmap_vote_counts';

  IF _src IS NULL OR _src !~* '\mlimit\M' THEN
    RAISE EXCEPTION 'roadmap_vote_counts still returns an unbounded row set';
  END IF;

  -- A vote with no request headers is unmetered and still lands. Asserted
  -- because the whole guard hangs off a header that a replay does not have,
  -- and "the throttle is skipped" must not quietly become "the vote is lost".
  PERFORM set_config('request.headers', '', true);
  PERFORM public.cast_roadmap_vote('probe-headless', 'probe-headless-0');
  IF NOT EXISTS (SELECT 1 FROM public.roadmap_votes WHERE feature = 'probe-headless') THEN
    RAISE EXCEPTION 'a vote with no request headers did not land';
  END IF;

  -- And the limit itself, end to end, from whatever state this database is in:
  -- 60 votes from one address go through and the 61st does not.
  PERFORM set_config('request.headers', '{"cf-connecting-ip":"198.51.100.7"}', true);
  _hash := encode(sha256(convert_to('houndstack-roadmap-throttle:v1:198.51.100.7', 'UTF8')), 'hex');
  DELETE FROM public.roadmap_vote_throttle WHERE ip_hash = _hash;

  FOR i IN 1..60 LOOP
    PERFORM public.cast_roadmap_vote('probe-throttle', 'probe-' || lpad(i::text, 4, '0'));
  END LOOP;

  SELECT count(*) INTO _landed FROM public.roadmap_votes WHERE feature = 'probe-throttle';
  IF _landed <> 60 THEN
    RAISE EXCEPTION 'the rate limit refused a vote inside the cap: % of 60 landed', _landed;
  END IF;

  BEGIN
    PERFORM public.cast_roadmap_vote('probe-throttle', 'probe-0061');
    _blocked := false;
  EXCEPTION WHEN others THEN
    -- The subtransaction rolls back this call only; the 60 above are outside it.
    _blocked := true;
  END;

  IF NOT _blocked THEN
    RAISE EXCEPTION 'the 61st vote from one address went through; the rate limit does nothing';
  END IF;

  -- And the window reopens. Without this the failure mode is not a leaky limit
  -- but a permanent lockout: an address that hit the cap once would be refused
  -- for the life of the row, which is worse than what this file is fixing.
  UPDATE public.roadmap_vote_throttle
     SET window_started_at = now() - interval '2 hours'
   WHERE ip_hash = _hash;

  BEGIN
    PERFORM public.cast_roadmap_vote('probe-throttle', 'probe-9999');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the address was still refused after its hour was up: %', SQLERRM;
  END;

  IF NOT EXISTS (SELECT 1 FROM public.roadmap_votes WHERE voter_id = 'probe-9999') THEN
    RAISE EXCEPTION 'the address was still refused after its hour was up';
  END IF;
  IF (SELECT votes FROM public.roadmap_vote_throttle WHERE ip_hash = _hash) <> 1 THEN
    RAISE EXCEPTION 'the counter did not restart when the window reopened';
  END IF;

  -- One address's votes do not clear another's counter. The prune runs on every
  -- call, so a prune with the wrong WHERE turns the limit into a no-op for
  -- everyone at once, and a proof that only ever uses one address cannot see it.
  _other := encode(sha256(convert_to('houndstack-roadmap-throttle:v1:198.51.100.90', 'UTF8')), 'hex');
  DELETE FROM public.roadmap_vote_throttle WHERE ip_hash IN (_hash, _other);

  PERFORM set_config('request.headers', '{"cf-connecting-ip":"198.51.100.90"}', true);
  PERFORM public.cast_roadmap_vote('probe-throttle', 'probe-other-1');

  PERFORM set_config('request.headers', '{"cf-connecting-ip":"198.51.100.7"}', true);
  FOR i IN 1..5 LOOP
    PERFORM public.cast_roadmap_vote('probe-throttle', 'probe-b-' || lpad(i::text, 4, '0'));
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.roadmap_vote_throttle WHERE ip_hash = _other) THEN
    RAISE EXCEPTION 'one address voting wiped another address''s counter; the limit is a no-op';
  END IF;

  -- x-forwarded-for is read from the BACK. Pinned here because the difference
  -- between the two ends of that header is the difference between a limit and
  -- an opt-out: a caller can prepend anything it likes to the list.
  _front := encode(sha256(convert_to('houndstack-roadmap-throttle:v1:203.0.113.1', 'UTF8')), 'hex');
  _back  := encode(sha256(convert_to('houndstack-roadmap-throttle:v1:198.51.100.8', 'UTF8')), 'hex');
  DELETE FROM public.roadmap_vote_throttle WHERE ip_hash IN (_front, _back);

  PERFORM set_config('request.headers', '{"x-forwarded-for":"203.0.113.1, 198.51.100.8"}', true);
  PERFORM public.cast_roadmap_vote('probe-throttle', 'probe-xff-1');

  IF NOT EXISTS (SELECT 1 FROM public.roadmap_vote_throttle WHERE ip_hash = _back) THEN
    RAISE EXCEPTION 'x-forwarded-for was not metered against the address the gateway appended';
  END IF;
  IF EXISTS (SELECT 1 FROM public.roadmap_vote_throttle WHERE ip_hash = _front) THEN
    RAISE EXCEPTION 'x-forwarded-for was metered against the caller-supplied end of the list';
  END IF;

  DELETE FROM public.roadmap_votes WHERE feature IN ('probe-throttle', 'probe-headless');
  DELETE FROM public.roadmap_vote_throttle WHERE ip_hash IN (_hash, _other, _front, _back);
  PERFORM set_config('request.headers', '', true);

  RAISE NOTICE 'roadmap poll: 60 votes/address/hour, per address, read from the end of the header, proven end to end and the probe rows removed';
END
$est$;

-- ---------------------------------------------------------------------------
-- What was true of the live database on the day this was written. A fresh build
-- has none of it, so this warns and never fails.
-- ---------------------------------------------------------------------------

DO $premise$
DECLARE
  _rows     bigint;
  _features bigint;
  _voters   bigint;
BEGIN
  SELECT count(*), count(DISTINCT feature), count(DISTINCT voter_id)
    INTO _rows, _features, _voters
    FROM public.roadmap_votes;

  IF _rows = 0 THEN
    RAISE WARNING 'roadmap poll: SKIPPED the before-and-after count — no votes in this database, which is what a fresh build looks like';
  ELSE
    RAISE WARNING 'roadmap poll: % rows, % features, % voters at the time the limit went in (2026-09-13: 2, 2, 2)',
      _rows, _features, _voters;
  END IF;
END
$premise$;
