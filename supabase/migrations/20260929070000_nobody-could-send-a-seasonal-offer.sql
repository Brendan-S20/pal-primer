-- Nobody could send a seasonal offer.
--
-- HoundStack sent lifecycle email on its own schedule (win-back, the seasonal
-- deep clean, reminders) and nothing else. An owner who wanted to tell every
-- client "Spring deep clean, $20 off" or "we now serve Oak Park" or "no
-- visits on the 25th" had to export a CSV and use something else. Jobber sells
-- this as Campaigns, a paid Marketing add-on.
--
-- This file is the storage half of version one. The page is
-- src/routes/_authenticated/campaigns.*, the sending is
-- src/lib/campaigns.server.ts, and the rules the audience obeys are
-- src/lib/campaigns.ts.
--
-- ── WHAT IS HERE ───────────────────────────────────────────────────────────
--
--   email_campaigns             one row per campaign: content, audience,
--                               status draft -> sending -> sent, who pressed
--                               Send and when.
--   email_campaign_recipients   the audience FROZEN at the moment Send was
--                               pressed, one row per client, UNIQUE on
--                               (campaign_id, client_id). That constraint is
--                               the answer to a double press: a second insert
--                               of the same client is a no-op, not a second
--                               email.
--   client_unsubscribe_tokens   the link at the foot of every campaign email.
--                               Redeeming one sets clients.email_opt_out on
--                               ONE client in ONE organization.
--   campaign_emails (pgmq)      a third lane beside auth_emails and
--                               transactional_emails, read last by
--                               /email/queue/process.
--
-- ── WHY A SEPARATE UNSUBSCRIBE TABLE, WHEN ONE EXISTS ─────────────────────
--
-- email_unsubscribe_tokens and the /unsubscribe page are reused: the page is
-- the same page and /email/unsubscribe the same endpoint. The TABLE could not
-- be. It is UNIQUE(email) and carries no organization, and redeeming a row
-- writes the address to suppressed_emails, which is global: an unsubscribe
-- from one business's spring promotion would silently stop every invoice,
-- receipt and reminder from every business on the platform that serves the
-- same person. And /email/transactional/send upserts ON CONFLICT (email), so
-- the unique constraint cannot be relaxed to make room for a scope without
-- breaking that writer. So the scoped token lives beside it, and the endpoint
-- asks this table second.
--
-- ── WHY A THIRD QUEUE ─────────────────────────────────────────────────────
--
-- The processor reads batch_size (10) messages per queue per tick, once a
-- minute, and drops a transactional message older than
-- transactional_email_ttl_minutes (60). Five thousand campaign emails put on
-- transactional_emails at once would take eight hours to drain, most of them
-- would be dead-lettered as expired after the first hour, and every invoice,
-- receipt and on-my-way text behind them would wait. A campaign therefore has
-- its own lane, read after the other two, and is fed into it a batch at a
-- time: the recipients rows are the backlog, the queue holds only what is
-- about to go.
--
-- ── LEADS ─────────────────────────────────────────────────────────────────
--
-- Not in version one, and the CHECK on audience_kind says so. See
-- src/lib/campaigns.ts, LEADS_ARE_NOT_AN_AUDIENCE_YET.
--
-- ── REPLAY ────────────────────────────────────────────────────────────────
--
-- Creates everything it asserts. Idempotent, so the proof in
-- tests/sql/nobody-could-send-a-seasonal-offer.proof.sql can apply it again
-- inside a transaction on a stack that already has it.

-- ── Campaigns ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft',
  subject text NOT NULL DEFAULT '',
  heading text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  button_label text,
  button_url text,
  audience_kind text NOT NULL DEFAULT 'active',
  audience_tag text,
  recipient_count integer,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_by uuid,
  sent_at timestamptz,
  completed_at timestamptz
);

ALTER TABLE public.email_campaigns DROP CONSTRAINT IF EXISTS email_campaigns_status_check;
ALTER TABLE public.email_campaigns ADD CONSTRAINT email_campaigns_status_check
  CHECK (status IN ('draft', 'sending', 'sent'));

-- Lengths match the zod schema in src/lib/campaigns.ts, so a validation
-- message is what an owner sees, never a Postgres error string.
ALTER TABLE public.email_campaigns DROP CONSTRAINT IF EXISTS email_campaigns_lengths_check;
ALTER TABLE public.email_campaigns ADD CONSTRAINT email_campaigns_lengths_check
  CHECK (
    length(subject) <= 150 AND length(heading) <= 150 AND length(body) <= 5000
    AND (button_label IS NULL OR length(button_label) BETWEEN 1 AND 40)
    AND (button_url IS NULL OR length(button_url) <= 500)
  );

-- A subject is a mail header. A line break in one is a header injection.
ALTER TABLE public.email_campaigns DROP CONSTRAINT IF EXISTS email_campaigns_subject_one_line_check;
ALTER TABLE public.email_campaigns ADD CONSTRAINT email_campaigns_subject_one_line_check
  CHECK (subject !~ '[\r\n]');

-- The button goes somewhere a customer can trust, or nowhere: https only,
-- and a label and a link together or neither.
ALTER TABLE public.email_campaigns DROP CONSTRAINT IF EXISTS email_campaigns_button_check;
ALTER TABLE public.email_campaigns ADD CONSTRAINT email_campaigns_button_check
  CHECK (
    (button_label IS NULL) = (button_url IS NULL)
    AND (button_url IS NULL OR button_url ~ '^https://[^\s/@]+\.[^\s/@]+(/\S*)?$')
  );

ALTER TABLE public.email_campaigns DROP CONSTRAINT IF EXISTS email_campaigns_audience_check;
ALTER TABLE public.email_campaigns ADD CONSTRAINT email_campaigns_audience_check
  CHECK (
    audience_kind IN ('active', 'tagged', 'inactive')
    AND (audience_kind = 'tagged') = (audience_tag IS NOT NULL)
    AND (audience_tag IS NULL OR length(btrim(audience_tag)) BETWEEN 1 AND 40)
  );

-- Once it has gone, it has a sender, a time, a subject and a body. A draft has
-- none of the first two.
ALTER TABLE public.email_campaigns DROP CONSTRAINT IF EXISTS email_campaigns_sent_shape_check;
ALTER TABLE public.email_campaigns ADD CONSTRAINT email_campaigns_sent_shape_check
  CHECK (
    CASE WHEN status = 'draft'
      THEN sent_at IS NULL AND sent_by IS NULL AND completed_at IS NULL
      ELSE sent_at IS NOT NULL AND sent_by IS NOT NULL
           AND length(btrim(subject)) > 0 AND length(btrim(body)) > 0
           AND recipient_count BETWEEN 1 AND 5000
    END
  );

CREATE INDEX IF NOT EXISTS email_campaigns_org_created_idx
  ON public.email_campaigns (organization_id, created_at DESC);

DROP TRIGGER IF EXISTS email_campaigns_touch_updated_at ON public.email_campaigns;
CREATE TRIGGER email_campaigns_touch_updated_at
  BEFORE UPDATE ON public.email_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

COMMENT ON TABLE public.email_campaigns IS
  'A marketing email to a chosen set of clients. Drafts are edited by the office through RLS; draft -> sending -> sent is written only by start_email_campaign and settle_email_campaigns.';

-- ── Recipients: the audience, frozen at Send ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  skip_reason text,
  message_id text,
  claimed_at timestamptz,
  queued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.email_campaign_recipients DROP CONSTRAINT IF EXISTS email_campaign_recipients_status_check;
ALTER TABLE public.email_campaign_recipients ADD CONSTRAINT email_campaign_recipients_status_check
  CHECK (status IN ('pending', 'claimed', 'queued', 'skipped'));

-- The double-send guard. One client, one campaign, one row, whatever presses
-- or retries arrive.
CREATE UNIQUE INDEX IF NOT EXISTS email_campaign_recipients_once_key
  ON public.email_campaign_recipients (campaign_id, client_id);

CREATE INDEX IF NOT EXISTS email_campaign_recipients_backlog_idx
  ON public.email_campaign_recipients (campaign_id)
  WHERE status IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS email_campaign_recipients_org_idx
  ON public.email_campaign_recipients (organization_id, campaign_id);

COMMENT ON TABLE public.email_campaign_recipients IS
  'One row per client a campaign is going to, frozen when Send is pressed. UNIQUE (campaign_id, client_id) is what makes a double press a no-op.';

-- ── Client-scoped unsubscribe tokens ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_unsubscribe_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS client_unsubscribe_tokens_token_key
  ON public.client_unsubscribe_tokens (token);
-- One per client, reused by every campaign that client is sent. The state of
-- the link is the client's email_opt_out, not the token's used_at, so a client
-- the office opts back in is not told "already unsubscribed" by the next one.
CREATE UNIQUE INDEX IF NOT EXISTS client_unsubscribe_tokens_client_key
  ON public.client_unsubscribe_tokens (client_id);

ALTER TABLE public.client_unsubscribe_tokens DROP CONSTRAINT IF EXISTS client_unsubscribe_tokens_token_check;
ALTER TABLE public.client_unsubscribe_tokens ADD CONSTRAINT client_unsubscribe_tokens_token_check
  CHECK (token ~ '^[0-9a-f]{64}$');

COMMENT ON TABLE public.client_unsubscribe_tokens IS
  'The unsubscribe link in a campaign email. Redeeming it sets email_opt_out on exactly one client in exactly one organization; it never writes the global suppressed_emails list.';

-- ── RLS and grants ─────────────────────────────────────────────────────────

ALTER TABLE public.email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;

-- Default privileges hand a new public table to anon and authenticated with
-- ALL, TRUNCATE included, and TRUNCATE does not ask RLS. Taken back.
REVOKE ALL ON public.email_campaigns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.email_campaign_recipients FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.client_unsubscribe_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_campaigns TO authenticated;
GRANT ALL ON public.email_campaigns TO service_role;
GRANT ALL ON public.email_campaign_recipients TO service_role;
GRANT ALL ON public.client_unsubscribe_tokens TO service_role;

-- The office writes DRAFTS and nothing else. Leaving draft is
-- start_email_campaign's job, which checks the business address and freezes
-- the audience in the same transaction.
DROP POLICY IF EXISTS "campaigns readable by campaign senders" ON public.email_campaigns;
CREATE POLICY "campaigns readable by campaign senders" ON public.email_campaigns
  FOR SELECT TO authenticated
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'send_campaigns'));

DROP POLICY IF EXISTS "campaign drafts writable by campaign senders (insert)" ON public.email_campaigns;
CREATE POLICY "campaign drafts writable by campaign senders (insert)" ON public.email_campaigns
  FOR INSERT TO authenticated
  WITH CHECK (
    status = 'draft'
    AND public.has_permission((SELECT auth.uid()), organization_id, 'send_campaigns')
  );

DROP POLICY IF EXISTS "campaign drafts writable by campaign senders (update)" ON public.email_campaigns;
CREATE POLICY "campaign drafts writable by campaign senders (update)" ON public.email_campaigns
  FOR UPDATE TO authenticated
  USING (
    status = 'draft'
    AND public.has_permission((SELECT auth.uid()), organization_id, 'send_campaigns')
  )
  WITH CHECK (
    status = 'draft'
    AND public.has_permission((SELECT auth.uid()), organization_id, 'send_campaigns')
  );

DROP POLICY IF EXISTS "campaign drafts writable by campaign senders (delete)" ON public.email_campaigns;
CREATE POLICY "campaign drafts writable by campaign senders (delete)" ON public.email_campaigns
  FOR DELETE TO authenticated
  USING (
    status = 'draft'
    AND public.has_permission((SELECT auth.uid()), organization_id, 'send_campaigns')
  );

-- email_campaign_recipients and client_unsubscribe_tokens have no policy for
-- any API role: the server reads and writes them with the service role only.

-- ── The lane ───────────────────────────────────────────────────────────────

DO $$ BEGIN PERFORM pgmq.create('campaign_emails'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.create('campaign_emails_dlq'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- How much is already waiting in a lane, so the processor feeds the campaign
-- lane up to one batch and no further: if sending stalls, the backlog stays in
-- email_campaign_recipients rather than piling into the queue to expire.
CREATE OR REPLACE FUNCTION public.email_queue_depth(queue_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _n bigint;
BEGIN
  SELECT m.queue_length INTO _n FROM pgmq.metrics(queue_name) m;
  RETURN COALESCE(_n, 0);
EXCEPTION WHEN undefined_table OR invalid_parameter_value THEN
  RETURN 0;
END;
$$;
REVOKE ALL ON FUNCTION public.email_queue_depth(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_queue_depth(text) TO service_role;

-- ── Send: freeze the audience and leave draft, or refuse ───────────────────
--
-- Everything that decides whether a campaign may go is checked here, under a
-- lock on the campaign row, so two presses of Send cannot both pass:
--
--   * the campaign is this organization's and still a draft
--   * the organization has a business address (CAN-SPAM: every commercial
--     email carries the sender's physical postal address)
--   * the recipient list is non-empty and at most 5,000
--   * every recipient is a client OF THIS ORGANIZATION who has not opted out
--     (the join below drops anything else, so a hand-built list cannot reach
--     another tenant's customers)
--
-- Returns 'started', or the reason it did not: 'not_found',
-- 'already_started', 'no_address', 'no_recipients', 'too_many'.
CREATE OR REPLACE FUNCTION public.start_email_campaign(
  _campaign_id uuid,
  _org_id uuid,
  _user_id uuid,
  _recipients jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _c public.email_campaigns%ROWTYPE;
  _address text;
  _n integer;
BEGIN
  SELECT * INTO _c FROM public.email_campaigns
   WHERE id = _campaign_id AND organization_id = _org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF _c.status <> 'draft' THEN
    RETURN 'already_started';
  END IF;

  SELECT contact_address INTO _address FROM public.organizations WHERE id = _org_id;
  IF _address IS NULL OR length(btrim(_address)) = 0 THEN
    RETURN 'no_address';
  END IF;

  IF _recipients IS NULL OR jsonb_typeof(_recipients) <> 'array'
     OR jsonb_array_length(_recipients) = 0 THEN
    RETURN 'no_recipients';
  END IF;
  IF jsonb_array_length(_recipients) > 5000 THEN
    RETURN 'too_many';
  END IF;

  -- A draft never has recipients; clear any left by a send that failed
  -- between here and the status flip, so an edited audience starts clean.
  DELETE FROM public.email_campaign_recipients WHERE campaign_id = _campaign_id;

  INSERT INTO public.email_campaign_recipients (campaign_id, organization_id, client_id, email)
  SELECT _campaign_id, _org_id, c.id, lower(btrim(c.primary_email))
    FROM jsonb_to_recordset(_recipients) AS x(client_id uuid)
    JOIN public.clients c
      ON c.id = x.client_id
     AND c.organization_id = _org_id
     AND NOT c.email_opt_out
     AND NOT c.comms_paused
     AND length(btrim(COALESCE(c.primary_email, ''))) > 0
  ON CONFLICT (campaign_id, client_id) DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;

  IF _n = 0 THEN
    RETURN 'no_recipients';
  END IF;

  UPDATE public.email_campaigns
     SET status = 'sending',
         sent_at = now(),
         sent_by = _user_id,
         recipient_count = _n
   WHERE id = _campaign_id;

  RETURN 'started';
END;
$$;
REVOKE ALL ON FUNCTION public.start_email_campaign(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_email_campaign(uuid, uuid, uuid, jsonb) TO service_role;

-- ── Feed the lane: claim a batch of recipients ─────────────────────────────
--
-- SKIP LOCKED so the Send button's first batch and the minute's processor tick
-- never take the same row. A row claimed and never finished (the worker died
-- mid-batch) is taken again after ten minutes; if the first attempt did reach
-- the queue, the Resend Idempotency-Key campaign-<id>-<clientId> is what stops
-- the second one becoming a second email.
CREATE OR REPLACE FUNCTION public.claim_email_campaign_recipients(_limit integer)
RETURNS TABLE (
  recipient_id uuid,
  campaign_id uuid,
  organization_id uuid,
  client_id uuid,
  email text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH picked AS (
    SELECT r.id
      FROM public.email_campaign_recipients r
      JOIN public.email_campaigns c ON c.id = r.campaign_id
     WHERE c.status = 'sending'
       AND (r.status = 'pending'
            OR (r.status = 'claimed' AND r.claimed_at < now() - interval '10 minutes'))
     ORDER BY c.sent_at, r.created_at, r.id
     LIMIT GREATEST(LEAST(COALESCE(_limit, 0), 100), 0)
     FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE public.email_campaign_recipients r
     SET status = 'claimed', claimed_at = now()
    FROM picked
   WHERE r.id = picked.id
  RETURNING r.id, r.campaign_id, r.organization_id, r.client_id, r.email;
$$;
REVOKE ALL ON FUNCTION public.claim_email_campaign_recipients(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_email_campaign_recipients(integer) TO service_role;

-- A campaign with nothing left to feed is sent.
CREATE OR REPLACE FUNCTION public.settle_email_campaigns()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH done AS (
    UPDATE public.email_campaigns c
       SET status = 'sent', completed_at = now()
     WHERE c.status = 'sending'
       AND NOT EXISTS (
         SELECT 1 FROM public.email_campaign_recipients r
          WHERE r.campaign_id = c.id AND r.status IN ('pending', 'claimed')
       )
    RETURNING 1
  )
  SELECT count(*)::integer FROM done;
$$;
REVOKE ALL ON FUNCTION public.settle_email_campaigns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_email_campaigns() TO service_role;

-- ── What happened to each campaign ─────────────────────────────────────────
--
-- Read from email_send_log, which is the only record of delivery this product
-- keeps:
--   sent     the mail provider accepted it (a 'sent' row for its message_id)
--   failed   it never got that far and was dead-lettered ('dlq')
--   bounced  accepted, then a bounce or complaint came back for the
--            provider's id (the webhook logs those under Resend's id, which
--            the 'sent' row carries in metadata.provider_message_id)
-- "Delivered to the inbox" is NOT here, because nothing records it: the Resend
-- webhook acknowledges email.delivered and logs it to the console only.
CREATE OR REPLACE FUNCTION public.email_campaign_stats(_org_id uuid)
RETURNS TABLE (
  campaign_id uuid,
  recipients integer,
  waiting integer,
  in_queue integer,
  skipped integer,
  sent integer,
  failed integer,
  bounced integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT r.campaign_id,
         count(*)::integer,
         count(*) FILTER (WHERE r.status IN ('pending', 'claimed'))::integer,
         count(*) FILTER (WHERE r.status = 'queued'
                            AND NOT COALESCE(l.sent, false)
                            AND NOT COALESCE(l.dlq, false))::integer,
         count(*) FILTER (WHERE r.status = 'skipped')::integer,
         count(*) FILTER (WHERE COALESCE(l.sent, false))::integer,
         count(*) FILTER (WHERE NOT COALESCE(l.sent, false) AND COALESCE(l.dlq, false))::integer,
         count(*) FILTER (WHERE COALESCE(l.bounced, false))::integer
    FROM public.email_campaign_recipients r
    LEFT JOIN LATERAL (
      SELECT bool_or(s.status = 'sent') AS sent,
             bool_or(s.status = 'dlq') AS dlq,
             EXISTS (
               SELECT 1 FROM public.email_send_log b
                WHERE b.status IN ('bounced', 'complained')
                  AND b.message_id IN (
                    SELECT s2.metadata->>'provider_message_id'
                      FROM public.email_send_log s2
                     WHERE s2.message_id = r.message_id AND s2.status = 'sent'
                  )
             ) AS bounced
        FROM public.email_send_log s
       WHERE s.message_id = r.message_id
    ) l ON r.message_id IS NOT NULL
   WHERE r.organization_id = _org_id
   GROUP BY r.campaign_id;
$$;
REVOKE ALL ON FUNCTION public.email_campaign_stats(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_campaign_stats(uuid) TO service_role;

-- ── The unsubscribe link ───────────────────────────────────────────────────

-- 'ready', 'already' or 'invalid', for the confirmation page.
CREATE OR REPLACE FUNCTION public.client_unsubscribe_token_state(_token text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
           WHEN c.id IS NULL THEN 'invalid'
           WHEN c.email_opt_out THEN 'already'
           ELSE 'ready'
         END
    FROM (SELECT 1) AS one
    LEFT JOIN public.client_unsubscribe_tokens t ON t.token = _token
    LEFT JOIN public.clients c
      ON c.id = t.client_id AND c.organization_id = t.organization_id;
$$;
REVOKE ALL ON FUNCTION public.client_unsubscribe_token_state(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_unsubscribe_token_state(text) TO service_role;

-- Opt ONE client out, in the ONE organization the token was minted for.
-- 'unsubscribed', 'already' or 'invalid'. Both keys are matched: a token row
-- whose client_id somehow named another tenant's client changes nothing.
CREATE OR REPLACE FUNCTION public.redeem_client_unsubscribe_token(_token text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _t public.client_unsubscribe_tokens%ROWTYPE;
  _n integer;
BEGIN
  SELECT * INTO _t FROM public.client_unsubscribe_tokens WHERE token = _token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'invalid';
  END IF;

  UPDATE public.clients
     SET email_opt_out = true, updated_at = now()
   WHERE id = _t.client_id
     AND organization_id = _t.organization_id
     AND NOT email_opt_out;
  GET DIAGNOSTICS _n = ROW_COUNT;

  IF _n = 0 THEN
    IF EXISTS (SELECT 1 FROM public.clients
                WHERE id = _t.client_id AND organization_id = _t.organization_id) THEN
      RETURN 'already';
    END IF;
    RETURN 'invalid';
  END IF;

  UPDATE public.client_unsubscribe_tokens SET used_at = now() WHERE id = _t.id;
  RETURN 'unsubscribed';
END;
$$;
REVOKE ALL ON FUNCTION public.redeem_client_unsubscribe_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_client_unsubscribe_token(text) TO service_role;

-- ── What this file establishes ─────────────────────────────────────────────

DO $check$
DECLARE
  _fn text;
  _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['email_campaigns', 'email_campaign_recipients', 'client_unsubscribe_tokens'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || _t)::regclass) THEN
      RAISE EXCEPTION '% does not have row level security enabled', _t;
    END IF;
    IF has_table_privilege('anon', 'public.' || _t, 'SELECT')
       OR has_table_privilege('anon', 'public.' || _t, 'TRUNCATE')
       OR has_table_privilege('authenticated', 'public.' || _t, 'TRUNCATE') THEN
      RAISE EXCEPTION '% is readable by anon or truncatable by an API role', _t;
    END IF;
  END LOOP;

  FOREACH _t IN ARRAY ARRAY['email_campaign_recipients', 'client_unsubscribe_tokens'] LOOP
    IF has_table_privilege('authenticated', 'public.' || _t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || _t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || _t, 'UPDATE') THEN
      RAISE EXCEPTION '% is reachable by authenticated; it is service-role only', _t;
    END IF;
  END LOOP;

  -- Every write the office can make is to a draft, and asks for the
  -- permission rather than for bare membership.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'email_campaigns'
                AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
                AND (COALESCE(qual, '') || COALESCE(with_check, '') !~ 'send_campaigns'
                     OR COALESCE(qual, '') || COALESCE(with_check, '') !~ 'draft')) THEN
    RAISE EXCEPTION 'an email_campaigns write policy does not require a draft and send_campaigns';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'email_campaigns'
         AND permissive = 'PERMISSIVE') <> 4 THEN
    RAISE EXCEPTION 'email_campaigns does not have exactly its four policies';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public'
                AND tablename IN ('email_campaign_recipients', 'client_unsubscribe_tokens')
                AND permissive = 'PERMISSIVE') THEN
    RAISE EXCEPTION 'a service-role-only table has an API policy';
  END IF;

  IF NOT (SELECT indisunique FROM pg_index
           WHERE indexrelid = 'public.email_campaign_recipients_once_key'::regclass) THEN
    RAISE EXCEPTION 'a client can be a recipient of the same campaign twice';
  END IF;
  IF NOT (SELECT indisunique FROM pg_index
           WHERE indexrelid = 'public.client_unsubscribe_tokens_token_key'::regclass) THEN
    RAISE EXCEPTION 'client_unsubscribe_tokens.token is not unique';
  END IF;

  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.email_campaigns'::regclass
         AND conname = 'email_campaigns_button_check')) !~ 'https' THEN
    RAISE EXCEPTION 'a campaign button can link somewhere other than https';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.email_campaigns'::regclass
         AND conname = 'email_campaigns_sent_shape_check')) !~ '5000' THEN
    RAISE EXCEPTION 'a sent campaign is not capped at 5,000 recipients';
  END IF;

  FOREACH _fn IN ARRAY ARRAY[
    'public.email_queue_depth(text)',
    'public.start_email_campaign(uuid, uuid, uuid, jsonb)',
    'public.claim_email_campaign_recipients(integer)',
    'public.settle_email_campaigns()',
    'public.email_campaign_stats(uuid)',
    'public.client_unsubscribe_token_state(text)',
    'public.redeem_client_unsubscribe_token(text)'
  ] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = _fn::regprocedure) THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER', _fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc, unnest(proconfig) AS cfg
       WHERE oid = _fn::regprocedure AND cfg LIKE 'search_path=%'
    ) THEN
      RAISE EXCEPTION '% has no fixed search_path', _fn;
    END IF;
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by an API role; it is reached only through service_role', _fn;
    END IF;
    IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute %', _fn;
    END IF;
  END LOOP;

  -- Sending refuses an organization with no postal address, under a lock.
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.start_email_campaign(uuid, uuid, uuid, jsonb)'::regprocedure)
       !~ 'no_address' THEN
    RAISE EXCEPTION 'start_email_campaign does not refuse an organization with no address';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.start_email_campaign(uuid, uuid, uuid, jsonb)'::regprocedure)
       !~ 'FOR UPDATE' THEN
    RAISE EXCEPTION 'start_email_campaign does not lock the campaign it starts';
  END IF;
  -- The unsubscribe names both keys.
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.redeem_client_unsubscribe_token(text)'::regprocedure)
       !~ 'organization_id = _t\.organization_id' THEN
    RAISE EXCEPTION 'redeem_client_unsubscribe_token is not scoped to the token''s organization';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'campaign_emails') THEN
    RAISE EXCEPTION 'the campaign_emails queue does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'campaign_emails_dlq') THEN
    RAISE EXCEPTION 'the campaign_emails_dlq queue does not exist';
  END IF;
END
$check$;
