-- A reply to an automated text went nowhere.
--
-- Automated texts go out from the platform number, and the inbound webhook
-- only recognised replies to a business's OWN number, so every reply to an
-- automated text was dropped, STOP included. The app side of the fix routes
-- those replies by the most recent text the platform number sent to that
-- phone (src/lib/platform-inbound.server.ts).
--
-- This file is the half that needs a column: the dogs-secured handshake.
-- Operators teach customers to answer the "on my way" text with ENT (the dogs
-- are in, come in) or DNE (do not enter). Sweep&Go does it; the market
-- research found operators advertising it. The answer lands on the visit so
-- My Day can show it on the stop before the tech opens the gate.
--
--   visits.gate_reply     'enter' | 'do_not_enter', or NULL for no answer
--   visits.gate_reply_at  when the customer answered
--
-- Written only by the server with the service role, from the webhook.
--
-- Replays into an empty database: two columns and a constraint. The DO block
-- asserts only what this file creates.

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS gate_reply text,
  ADD COLUMN IF NOT EXISTS gate_reply_at timestamptz;

ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_gate_reply_is_one_the_webhook_writes;
ALTER TABLE public.visits ADD CONSTRAINT visits_gate_reply_is_one_the_webhook_writes
  CHECK (gate_reply IS NULL OR gate_reply IN ('enter', 'do_not_enter'));

COMMENT ON COLUMN public.visits.gate_reply IS
  'The customer''s answer to the "on my way" text: enter (dogs secured) or do_not_enter. Written by the inbound SMS webhook.';
COMMENT ON COLUMN public.visits.gate_reply_at IS
  'When the customer answered the "on my way" text.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'gate_reply'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'gate_reply_at'
       AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'visits.gate_reply / gate_reply_at are missing or mistyped';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.visits'::regclass
         AND conname = 'visits_gate_reply_is_one_the_webhook_writes')) !~ 'do_not_enter' THEN
    RAISE EXCEPTION 'visits.gate_reply is not constrained to enter / do_not_enter';
  END IF;
END
$check$;
