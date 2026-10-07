-- One decline counts once.
--
-- clients.autopay_failure_count is the dunning ladder: after
-- organizations.dunning_pause_after_failures declines, autopay pauses and the
-- office has to step in. A single declined charge could be counted more than
-- once, so autopay paused after fewer real declines than the business set,
-- as few as half:
--
--   1. The Stripe webhook incremented it on every delivery of
--      payment_intent.payment_failed. Stripe redelivers an event whenever a
--      delivery is not answered 200 in time, so one decline could count two
--      or three times.
--   2. The nightly autopay run's catch block ALSO incremented it when the
--      off-session charge it had just made came back declined. That decline
--      is a PaymentIntent, and Stripe sends payment_intent.payment_failed for
--      it a moment later, so the webhook counted it again.
--
-- Both read the count, added one in TypeScript and wrote it back, so the
-- increment was neither atomic nor idempotent.
--
-- Now one function owns the count, and it is idempotent per PaymentIntent:
-- count_autopay_decline(client, payment_intent, error) increments only if that
-- PaymentIntent has not been counted for this client before, in ONE UPDATE
-- whose WHERE clause carries the check, so two deliveries racing each other
-- serialize on the row lock and the second finds the PaymentIntent already
-- there. Which path calls it:
--
--   * the webhook, for every saved-card decline (source autopay or
--     portal_saved_card). It is the authoritative signal: Stripe sends it for
--     every decline that reached Stripe, whoever started the charge.
--   * the nightly run, ONLY for a failure that never produced a PaymentIntent
--     (the charge was refused before Stripe made one, or failed in our own
--     code first), with _payment_intent_id NULL. No webhook will ever arrive
--     for those, so nobody else can count them. A failure that carries a
--     PaymentIntent is left to the webhook; a network failure, a Stripe 5xx
--     or a rate limit is not counted at all, because it is not a decline and
--     may have reached Stripe, in which case the webhook counts it.
--
-- The record of what was counted is a column, not a table:
-- clients.autopay_counted_decline_pis, the last fifty PaymentIntents counted
-- for the client. It is deliberately NOT cleared when a payment succeeds and
-- the count resets: a redelivery of an old decline that arrives after the
-- reset must still be recognised, or it would start the new ladder at one.
-- Fifty is far beyond any ladder (the count pauses at the org's threshold,
-- default 3), and keeps the array bounded for a client whose card has been
-- declined on and off for years.
--
-- The pause is decided here too, from the same count, against the org's
-- threshold, so "pauses at N distinct declines" is one statement. It never
-- UN-pauses: the old code wrote `paused = count >= threshold`, so an org that
-- raised its threshold could see a decline lift a pause. Only a success or the
-- office's Resume clears it, as before.
--
-- Replays into an empty database: one column on a table an earlier migration
-- created, one new function, its grants. The check block reads no rows.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS autopay_counted_decline_pis text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.clients.autopay_counted_decline_pis IS
  'The last 50 Stripe PaymentIntent ids counted toward autopay_failure_count, so one decline counts once however many times it is reported. Written only by count_autopay_decline; not cleared when the count resets.';

CREATE OR REPLACE FUNCTION public.count_autopay_decline(
  _client_id uuid,
  _payment_intent_id text,
  _error text
)
RETURNS TABLE (counted boolean, failure_count integer, paused boolean, pause_after integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _threshold integer;
BEGIN
  IF _payment_intent_id IS NOT NULL
     AND (_payment_intent_id = '' OR char_length(_payment_intent_id) > 255) THEN
    RAISE EXCEPTION 'count_autopay_decline: % is not a PaymentIntent id', _payment_intent_id
      USING ERRCODE = '22023';
  END IF;

  SELECT o.dunning_pause_after_failures
    INTO _threshold
    FROM public.clients c
    JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.id = _client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'count_autopay_decline: no client %', _client_id USING ERRCODE = 'P0002';
  END IF;
  _threshold := COALESCE(_threshold, 3);

  -- The idempotency check IS the WHERE clause. Under READ COMMITTED a second
  -- UPDATE that waited on this row's lock re-evaluates it against the row the
  -- first one wrote, so a racing duplicate finds the PaymentIntent and
  -- updates nothing.
  RETURN QUERY
  UPDATE public.clients c
     SET autopay_failure_count = c.autopay_failure_count + 1,
         autopay_paused = c.autopay_paused OR (c.autopay_failure_count + 1) >= _threshold,
         autopay_last_error = COALESCE(_error, 'Card charge failed'),
         autopay_last_attempt_at = now(),
         autopay_counted_decline_pis = CASE
           WHEN _payment_intent_id IS NULL THEN c.autopay_counted_decline_pis
           ELSE (array_append(c.autopay_counted_decline_pis, _payment_intent_id))
                  [greatest(cardinality(c.autopay_counted_decline_pis) - 48, 1):]
         END
   WHERE c.id = _client_id
     AND (_payment_intent_id IS NULL
          OR NOT (_payment_intent_id = ANY (c.autopay_counted_decline_pis)))
  RETURNING true, c.autopay_failure_count, c.autopay_paused, _threshold;

  IF NOT FOUND THEN
    -- Already counted: report where the ladder stands, change nothing.
    RETURN QUERY
    SELECT false, c.autopay_failure_count, c.autopay_paused, _threshold
      FROM public.clients c
     WHERE c.id = _client_id;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.count_autopay_decline(uuid, text, text) IS
  'The one place a declined autopay or saved-card charge is counted toward the dunning ladder. Idempotent per PaymentIntent: a PaymentIntent already in clients.autopay_counted_decline_pis is not counted again. NULL counts once per call, for a nightly failure that never reached Stripe. Pauses autopay at the org''s dunning_pause_after_failures. Service role only.';

-- The webhook and the nightly run use the service role. Nobody else may move a
-- client's ladder: a signed-in user who could call this could pause any
-- client's autopay.
REVOKE ALL ON FUNCTION public.count_autopay_decline(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_autopay_decline(uuid, text, text) TO service_role;

DO $check$
DECLARE
  _fn regprocedure := 'public.count_autopay_decline(uuid, text, text)'::regprocedure;
  _src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'clients'
       AND column_name = 'autopay_counted_decline_pis'
       AND data_type = 'ARRAY' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'clients.autopay_counted_decline_pis is missing or nullable';
  END IF;

  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'count_autopay_decline is executable with the publishable key';
  END IF;
  IF has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'count_autopay_decline is executable by any signed-in user';
  END IF;
  IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'count_autopay_decline is not callable by the webhook or the nightly run';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = _fn) THEN
    RAISE EXCEPTION 'count_autopay_decline must not be SECURITY DEFINER: only the service role calls it';
  END IF;

  -- The idempotency is the point of the function. Read its body (prosrc,
  -- which cannot raise for any prokind) and refuse a replacement that dropped
  -- the check.
  _src := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = _fn);
  IF strpos(_src, '= ANY (c.autopay_counted_decline_pis)') = 0 THEN
    RAISE EXCEPTION 'count_autopay_decline no longer checks whether the PaymentIntent was counted';
  END IF;
  IF strpos(_src, 'dunning_pause_after_failures') = 0 THEN
    RAISE EXCEPTION 'count_autopay_decline no longer reads the org''s pause threshold';
  END IF;
END
$check$;
