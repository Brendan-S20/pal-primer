-- Nothing could listen for a completed visit.
--
-- A business that runs its books in one tool, its reviews in another and its
-- mailing list in a third had no way to hear from HoundStack. Jobber answers
-- that with a Zapier integration; nobody in the pet-waste niche does it well.
-- This is version one: outbound webhooks. An owner registers an HTTPS URL,
-- picks the events it wants, and HoundStack POSTs a signed JSON body to it
-- every time one of them happens.
--
--   webhook_endpoints          one row per URL. Org-scoped, readable and
--                              editable by manage_settings (owner and office
--                              manager). CREATED only by the server, after the
--                              URL has passed the SSRF checks in
--                              src/lib/webhook-url-safety.ts, so authenticated
--                              has no INSERT, and its UPDATE is limited to
--                              description, events and enabled: the URL a
--                              signed request goes to cannot be rewritten
--                              through the API around those checks.
--   webhook_endpoint_secrets   the signing secret, AES-256-GCM encrypted by
--                              src/lib/secret-encryption.server.ts before it
--                              reaches the database (a CHECK refuses anything
--                              that is not in that envelope). Deny-all: RLS on,
--                              no policies, no grants to anon or authenticated.
--                              The owner sees the secret once, in the response
--                              that created or rotated it, and never again.
--   webhook_deliveries         the outbox. One row per (event, endpoint).
--
-- ── WHY TRIGGERS AND NOT APP CODE ─────────────────────────────────────────
--
-- A visit is completed from My Day, from the offline queue, from the office's
-- drawer, and by the nightly rollover; a client arrives by the wizard, by
-- import, by online signup and by lead conversion; an invoice is paid by
-- Stripe's webhook, by autopay, by account credit and by hand. Emitting from
-- each of those call sites is a list, and a list is the thing that is missing
-- the entry nobody remembered. A trigger on the row is every path at once,
-- including the ones written next year.
--
-- Each trigger fires on a TRANSITION, not on every write:
--
--   client.created     AFTER INSERT ON clients
--   visit.completed    AFTER UPDATE ON visits,   status becomes completed
--   visit.skipped      AFTER UPDATE ON visits,   status becomes skipped
--   invoice.created    AFTER INSERT ON invoices
--   invoice.paid       AFTER INSERT ON invoices already paid, or
--                      AFTER UPDATE ON invoices, status becomes paid
--   payment.received   AFTER INSERT ON payments already succeeded, or
--                      AFTER UPDATE ON payments, status becomes succeeded
--   quote.accepted     AFTER UPDATE ON quotes,   status becomes accepted
--   quote.declined     AFTER UPDATE ON quotes,   status becomes declined
--   lead.created       AFTER INSERT ON leads that belong to an organization
--
-- "Becomes" is `OLD.status IS DISTINCT FROM NEW.status`, in the trigger's
-- WHEN clause (so an ordinary edit of a completed visit never even calls the
-- function) and again inside the function. Plain AFTER UPDATE rather than
-- UPDATE OF status, because UPDATE OF only fires when the column is in the
-- statement's SET list, and a BEFORE trigger that moves the status would be
-- missed.
--
-- A trigger that cannot enqueue must not stop the business write it rides
-- on: a completed visit is the product, a webhook is a courtesy. So the
-- enqueue runs in its own exception block and a failure is a WARNING. The
-- block is entered only when the organization has an enabled endpoint, so an
-- organization that has never set one up pays one index probe per event.
--
-- ── WHAT A PAYLOAD CARRIES ────────────────────────────────────────────────
--
--   { "id", "type", "created_at", "organization_id", "data": { ... } }
--
-- `data` is ids, names, amounts, dates and statuses. Deliberately NOT: email
-- addresses, phone numbers, street addresses, gate codes and gate replies,
-- technician notes, free-text reasons, portal or public tokens, checkout
-- links, Stripe ids, card details, or the raw Stripe event. A webhook body
-- leaves this system for a third party's logs; the receiver can look the rest
-- up. tests/nothing-could-listen-for-a-completed-visit.test.ts pins each key.
--
-- ── DELIVERY ──────────────────────────────────────────────────────────────
--
-- Every minute, pg_cron POSTs to /api/public/hooks/webhook-deliveries with
-- the service-role key from Vault, the same shape the email queue uses, but
-- only when a delivery is due: the job's command selects from the outbox
-- first, so an idle minute makes no HTTP request at all. The route claims a
-- batch through webhook_claim_deliveries (FOR UPDATE SKIP LOCKED, and a lease
-- so a crashed run's rows come back), signs, sends with a 10 second timeout
-- and redirects refused, and records each result through
-- webhook_record_attempt. The retry schedule lives in TypeScript
-- (src/lib/webhook-delivery.server.ts): 1m, 5m, 30m, 2h, 12h, then failed.
-- After five deliveries in a row end failed, record_attempt switches the
-- endpoint off and the route notifies the owners.
--
-- ── REPLAY ────────────────────────────────────────────────────────────────
--
-- Three new tables, functions, and triggers on tables earlier migrations
-- create. The cron job is scheduled HERE, so a replay establishes it, and
-- the check at the bottom still only WARNS about it: the-wiring-is-connected
-- collects schedules after checking each file, so a file cannot vouch for a
-- job it schedules itself, and pg_cron may be absent. Everything else the
-- check asserts, this file creates.

-- ── 1. Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  url text NOT NULL,
  description text NOT NULL DEFAULT '',
  events text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- The last four characters of the secret, for a "whsec_...4f2a" hint. The
  -- secret itself is in webhook_endpoint_secrets.
  secret_last4 text,
  -- Deliveries in a row that ended failed (all retries used). Reset by any
  -- success and by switching the endpoint back on.
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  disabled_reason text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The database's half of "https only". The rest of the SSRF rules need DNS
  -- and live in the app, at save time and again at send time.
  CONSTRAINT webhook_endpoints_url_is_https CHECK (url ~ '^https://[^[:space:]]+$' AND length(url) <= 2048),
  CONSTRAINT webhook_endpoints_description_length CHECK (length(description) <= 200),
  CONSTRAINT webhook_endpoints_has_events CHECK (cardinality(events) > 0),
  CONSTRAINT webhook_endpoints_events_known CHECK (
    events <@ ARRAY[
      'client.created', 'visit.completed', 'visit.skipped', 'invoice.created', 'invoice.paid',
      'payment.received', 'quote.accepted', 'quote.declined', 'lead.created'
    ]::text[]
  ),
  CONSTRAINT webhook_endpoints_failures_nonnegative CHECK (consecutive_failures >= 0)
);

COMMENT ON TABLE public.webhook_endpoints IS
  'Outbound webhook URLs an organization has registered. Created only by the server after SSRF checks; the signing secret is in webhook_endpoint_secrets.';

CREATE INDEX IF NOT EXISTS webhook_endpoints_organization_id ON public.webhook_endpoints (organization_id);
CREATE INDEX IF NOT EXISTS webhook_endpoints_created_by ON public.webhook_endpoints (created_by)
  WHERE created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.webhook_endpoint_secrets (
  endpoint_id uuid PRIMARY KEY REFERENCES public.webhook_endpoints(id) ON DELETE CASCADE,
  secret_ciphertext text NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  -- The envelope secret-encryption.server.ts writes: v1.<iv>.<tag>.<ct>. A
  -- plaintext secret is refused by the database, not merely by convention.
  CONSTRAINT webhook_endpoint_secrets_encrypted CHECK (secret_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
);

COMMENT ON TABLE public.webhook_endpoint_secrets IS
  'Encrypted webhook signing secrets. Deny-all to anon and authenticated; read only by the delivery worker on the service role.';

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES public.webhook_endpoints(id) ON DELETE CASCADE,
  -- The same id for every endpoint that receives one event, and the `id` in
  -- the body, so a receiver can de-duplicate a retried delivery.
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  last_status_code integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_status_check CHECK (status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT webhook_deliveries_event_type_check CHECK (
    event_type IN (
      'client.created', 'visit.completed', 'visit.skipped', 'invoice.created', 'invoice.paid',
      'payment.received', 'quote.accepted', 'quote.declined', 'lead.created', 'webhook.test'
    )
  ),
  CONSTRAINT webhook_deliveries_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT webhook_deliveries_one_per_endpoint_event UNIQUE (endpoint_id, event_id)
);

COMMENT ON TABLE public.webhook_deliveries IS
  'Outbound webhook outbox, filled by triggers on clients, visits, invoices, payments, quotes and leads, drained by /api/public/hooks/webhook-deliveries.';

-- The worker's question: what is due. Also serves the prune, which reads
-- terminal rows by the time of their last attempt.
CREATE INDEX IF NOT EXISTS webhook_deliveries_status_next_attempt
  ON public.webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_organization_id
  ON public.webhook_deliveries (organization_id);
-- The settings page's question: this endpoint's recent deliveries.
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_created
  ON public.webhook_deliveries (endpoint_id, created_at DESC);

-- ── 2. The endpoint's own bookkeeping ───────────────────────────────────────
--
-- Switching an endpoint back on starts it clean; switching it off says when.
-- A trigger rather than server code because the office can flip `enabled`
-- through the API directly (it holds UPDATE on that column), and the counters
-- have to agree with the switch whichever way it was flipped.
CREATE OR REPLACE FUNCTION public.webhook_endpoints_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  NEW.updated_at := now();
  IF NEW.enabled AND NOT OLD.enabled THEN
    NEW.consecutive_failures := 0;
    NEW.disabled_at := NULL;
    NEW.disabled_reason := NULL;
  ELSIF OLD.enabled AND NOT NEW.enabled THEN
    NEW.disabled_at := COALESCE(NEW.disabled_at, now());
    NEW.disabled_reason := COALESCE(NEW.disabled_reason, 'Switched off by the office');
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_endpoints_before_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS webhook_endpoints_before_update ON public.webhook_endpoints;
CREATE TRIGGER webhook_endpoints_before_update
  BEFORE UPDATE ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.webhook_endpoints_before_update();

-- ── 3. RLS and grants ───────────────────────────────────────────────────────

ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_endpoint_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.webhook_endpoints FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.webhook_endpoint_secrets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.webhook_deliveries FROM PUBLIC, anon, authenticated;

GRANT SELECT, DELETE ON public.webhook_endpoints TO authenticated;
GRANT UPDATE (description, events, enabled) ON public.webhook_endpoints TO authenticated;
GRANT SELECT ON public.webhook_deliveries TO authenticated;

GRANT ALL ON public.webhook_endpoints TO service_role;
GRANT ALL ON public.webhook_endpoint_secrets TO service_role;
GRANT ALL ON public.webhook_deliveries TO service_role;

DROP POLICY IF EXISTS "webhook endpoints readable by settings managers" ON public.webhook_endpoints;
CREATE POLICY "webhook endpoints readable by settings managers" ON public.webhook_endpoints
  FOR SELECT TO authenticated
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'manage_settings'));

DROP POLICY IF EXISTS "webhook endpoints editable by settings managers" ON public.webhook_endpoints;
CREATE POLICY "webhook endpoints editable by settings managers" ON public.webhook_endpoints
  FOR UPDATE TO authenticated
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'manage_settings'))
  WITH CHECK (public.has_permission((SELECT auth.uid()), organization_id, 'manage_settings'));

DROP POLICY IF EXISTS "webhook endpoints removable by settings managers" ON public.webhook_endpoints;
CREATE POLICY "webhook endpoints removable by settings managers" ON public.webhook_endpoints
  FOR DELETE TO authenticated
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'manage_settings'));

DROP POLICY IF EXISTS "webhook deliveries readable by settings managers" ON public.webhook_deliveries;
CREATE POLICY "webhook deliveries readable by settings managers" ON public.webhook_deliveries
  FOR SELECT TO authenticated
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'manage_settings'));

-- webhook_endpoint_secrets: no policy, on purpose. See
-- tests/nine-tables-that-are-deny-all-on-purpose.test.ts.

-- ── 4. Enqueue ──────────────────────────────────────────────────────────────
--
-- One event id, one row per enabled endpoint in the organization that asked
-- for this type. Called by the trigger functions below, which run as their
-- owner, so nothing an API role holds reaches it.
CREATE OR REPLACE FUNCTION public.webhook_enqueue(_org uuid, _type text, _data jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _event uuid := gen_random_uuid();
  _n integer;
BEGIN
  IF _org IS NULL THEN
    RETURN 0;
  END IF;
  INSERT INTO public.webhook_deliveries (organization_id, endpoint_id, event_id, event_type, payload)
  SELECT e.organization_id, e.id, _event, _type,
         jsonb_build_object(
           'id', _event,
           'type', _type,
           'created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'organization_id', _org,
           'data', COALESCE(_data, '{}'::jsonb)
         )
    FROM public.webhook_endpoints e
   WHERE e.organization_id = _org
     AND e.enabled
     AND _type = ANY (e.events);
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_enqueue(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_enqueue(uuid, text, jsonb) TO service_role;

-- ── 5. The triggers ─────────────────────────────────────────────────────────

-- client.created
CREATE OR REPLACE FUNCTION public.webhook_emit_client()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.webhook_endpoints e
                  WHERE e.organization_id = NEW.organization_id AND e.enabled) THEN
    RETURN NULL;
  END IF;
  BEGIN
    PERFORM public.webhook_enqueue(NEW.organization_id, 'client.created', jsonb_build_object(
      'client_id', NEW.id,
      'display_name', NEW.display_name,
      'first_name', NEW.first_name,
      'last_name', NEW.last_name,
      'company', NEW.company,
      'account_type', NEW.account_type,
      'active', NEW.active,
      'created_at', NEW.created_at
    ));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook_emit_client: could not enqueue for client %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_emit_client() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS webhook_emit_client ON public.clients;
CREATE TRIGGER webhook_emit_client
  AFTER INSERT ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.webhook_emit_client();

-- visit.completed, visit.skipped
CREATE OR REPLACE FUNCTION public.webhook_emit_visit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _type text;
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NULL;
  END IF;
  _type := CASE NEW.status::text
             WHEN 'completed' THEN 'visit.completed'
             WHEN 'skipped' THEN 'visit.skipped'
           END;
  IF _type IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.webhook_endpoints e
                  WHERE e.organization_id = NEW.organization_id AND e.enabled) THEN
    RETURN NULL;
  END IF;
  BEGIN
    PERFORM public.webhook_enqueue(NEW.organization_id, _type, jsonb_build_object(
      'visit_id', NEW.id,
      'client_id', NEW.client_id,
      'client_name', (SELECT c.display_name FROM public.clients c WHERE c.id = NEW.client_id),
      'property_id', NEW.property_id,
      'subscription_id', NEW.subscription_id,
      'assigned_staff_id', NEW.assigned_staff_id,
      'scheduled_on', NEW.scheduled_on,
      'status', NEW.status,
      'completed_at', NEW.completed_at,
      'skipped_at', NEW.skipped_at,
      'skip_reason_code', NEW.skip_reason_code,
      'skip_billable', NEW.skip_billable,
      'is_deepclean', NEW.is_deepclean,
      'price_cents', NEW.price_cents
    ));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook_emit_visit: could not enqueue for visit %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_emit_visit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS webhook_emit_visit ON public.visits;
CREATE TRIGGER webhook_emit_visit
  AFTER UPDATE ON public.visits
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        AND NEW.status IN ('completed'::public.visit_status, 'skipped'::public.visit_status))
  EXECUTE FUNCTION public.webhook_emit_visit();

-- invoice.created, invoice.paid
CREATE OR REPLACE FUNCTION public.webhook_emit_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _data jsonb;
  _paid boolean;
BEGIN
  _paid := NEW.status = 'paid'::public.invoice_status
           AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status);
  IF TG_OP = 'UPDATE' AND NOT _paid THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.webhook_endpoints e
                  WHERE e.organization_id = NEW.organization_id AND e.enabled) THEN
    RETURN NULL;
  END IF;
  BEGIN
    _data := jsonb_build_object(
      'invoice_id', NEW.id,
      'number', NEW.number,
      'client_id', NEW.client_id,
      'client_name', (SELECT c.display_name FROM public.clients c WHERE c.id = NEW.client_id),
      'kind', NEW.kind,
      'status', NEW.status,
      'currency', NEW.currency,
      'subtotal_cents', NEW.subtotal_cents,
      'total_cents', NEW.total_cents,
      'credit_applied_cents', NEW.credit_applied_cents,
      'period_start', NEW.period_start,
      'period_end', NEW.period_end,
      'due_on', NEW.due_on,
      'issued_at', NEW.issued_at,
      'paid_at', NEW.paid_at,
      'created_at', NEW.created_at
    );
    IF TG_OP = 'INSERT' THEN
      PERFORM public.webhook_enqueue(NEW.organization_id, 'invoice.created', _data);
    END IF;
    IF _paid THEN
      PERFORM public.webhook_enqueue(NEW.organization_id, 'invoice.paid', _data);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook_emit_invoice: could not enqueue for invoice %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_emit_invoice() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS webhook_emit_invoice_insert ON public.invoices;
CREATE TRIGGER webhook_emit_invoice_insert
  AFTER INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.webhook_emit_invoice();

DROP TRIGGER IF EXISTS webhook_emit_invoice_paid ON public.invoices;
CREATE TRIGGER webhook_emit_invoice_paid
  AFTER UPDATE ON public.invoices
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'paid'::public.invoice_status)
  EXECUTE FUNCTION public.webhook_emit_invoice();

-- payment.received
CREATE OR REPLACE FUNCTION public.webhook_emit_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _client uuid;
  _number integer;
BEGIN
  IF NEW.status IS DISTINCT FROM 'succeeded'::public.payment_status
     OR (TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.webhook_endpoints e
                  WHERE e.organization_id = NEW.organization_id AND e.enabled) THEN
    RETURN NULL;
  END IF;
  BEGIN
    SELECT i.client_id, i.number INTO _client, _number
      FROM public.invoices i WHERE i.id = NEW.invoice_id;
    PERFORM public.webhook_enqueue(NEW.organization_id, 'payment.received', jsonb_build_object(
      'payment_id', NEW.id,
      'invoice_id', NEW.invoice_id,
      'invoice_number', _number,
      'client_id', _client,
      'client_name', (SELECT c.display_name FROM public.clients c WHERE c.id = _client),
      'amount_cents', NEW.amount_cents,
      'surcharge_cents', NEW.surcharge_cents,
      'currency', NEW.currency,
      'method', NEW.method,
      'paid_at', NEW.paid_at
    ));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook_emit_payment: could not enqueue for payment %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_emit_payment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS webhook_emit_payment_insert ON public.payments;
CREATE TRIGGER webhook_emit_payment_insert
  AFTER INSERT ON public.payments
  FOR EACH ROW
  WHEN (NEW.status = 'succeeded'::public.payment_status)
  EXECUTE FUNCTION public.webhook_emit_payment();

DROP TRIGGER IF EXISTS webhook_emit_payment_succeeded ON public.payments;
CREATE TRIGGER webhook_emit_payment_succeeded
  AFTER UPDATE ON public.payments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'succeeded'::public.payment_status)
  EXECUTE FUNCTION public.webhook_emit_payment();

-- quote.accepted, quote.declined
CREATE OR REPLACE FUNCTION public.webhook_emit_quote()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _type text;
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NULL;
  END IF;
  _type := CASE NEW.status
             WHEN 'accepted' THEN 'quote.accepted'
             WHEN 'declined' THEN 'quote.declined'
           END;
  IF _type IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.webhook_endpoints e
                  WHERE e.organization_id = NEW.organization_id AND e.enabled) THEN
    RETURN NULL;
  END IF;
  BEGIN
    PERFORM public.webhook_enqueue(NEW.organization_id, _type, jsonb_build_object(
      'quote_id', NEW.id,
      'number', NEW.number,
      'title', NEW.title,
      'status', NEW.status,
      'client_id', NEW.client_id,
      'lead_id', NEW.lead_id,
      'recipient_name', COALESCE(
        (SELECT c.display_name FROM public.clients c WHERE c.id = NEW.client_id),
        NEW.prospect_name
      ),
      'one_time_cents', (SELECT COALESCE(sum(l.amount_cents), 0)::integer
                           FROM public.quote_line_items l
                          WHERE l.quote_id = NEW.id AND NOT l.recurring),
      'recurring_cents', (SELECT COALESCE(sum(l.amount_cents), 0)::integer
                            FROM public.quote_line_items l
                           WHERE l.quote_id = NEW.id AND l.recurring),
      'sent_at', NEW.sent_at,
      'accepted_at', NEW.accepted_at,
      'accepted_name', NEW.accepted_name,
      'declined_at', NEW.declined_at,
      'valid_until', NEW.valid_until
    ));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook_emit_quote: could not enqueue for quote %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_emit_quote() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS webhook_emit_quote ON public.quotes;
CREATE TRIGGER webhook_emit_quote
  AFTER UPDATE ON public.quotes
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('accepted', 'declined'))
  EXECUTE FUNCTION public.webhook_emit_quote();

-- lead.created
CREATE OR REPLACE FUNCTION public.webhook_emit_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.organization_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.webhook_endpoints e
                  WHERE e.organization_id = NEW.organization_id AND e.enabled) THEN
    RETURN NULL;
  END IF;
  BEGIN
    PERFORM public.webhook_enqueue(NEW.organization_id, 'lead.created', jsonb_build_object(
      'lead_id', NEW.id,
      'name', NEW.name,
      'company', NEW.company,
      'source', NEW.source,
      'status', NEW.status,
      'dog_count', NEW.dog_count,
      'frequency', NEW.frequency,
      'created_at', NEW.created_at
    ));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook_emit_lead: could not enqueue for lead %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_emit_lead() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS webhook_emit_lead ON public.leads;
CREATE TRIGGER webhook_emit_lead
  AFTER INSERT ON public.leads
  FOR EACH ROW
  WHEN (NEW.organization_id IS NOT NULL)
  EXECUTE FUNCTION public.webhook_emit_lead();

-- ── 6. The worker's two calls ───────────────────────────────────────────────
--
-- Claim: take up to _limit due rows whose endpoint is on, bump attempts, and
-- push next_attempt_at out by a lease so an overlapping run skips them and a
-- run that dies leaves them to come back rather than stuck. With _only set it
-- claims that one row whatever its schedule or its endpoint's switch: that is
-- the "Send test event" button, which the office presses precisely to find
-- out whether an endpoint works.
CREATE OR REPLACE FUNCTION public.webhook_claim_deliveries(
  _limit integer,
  _lease_seconds integer,
  _only uuid DEFAULT NULL
)
RETURNS TABLE (
  delivery_id uuid,
  organization_id uuid,
  endpoint_id uuid,
  event_id uuid,
  event_type text,
  payload jsonb,
  attempts integer,
  url text,
  secret_ciphertext text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT d.id
      FROM public.webhook_deliveries d
      JOIN public.webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.status = 'pending'
       AND CASE WHEN _only IS NULL THEN d.next_attempt_at <= now() AND e.enabled
                ELSE d.id = _only END
     ORDER BY d.next_attempt_at
     LIMIT GREATEST(1, LEAST(COALESCE(_limit, 20), 100))
     FOR UPDATE OF d SKIP LOCKED
  ), claimed AS (
    UPDATE public.webhook_deliveries d
       SET attempts = d.attempts + 1,
           last_attempt_at = now(),
           next_attempt_at = now() + make_interval(secs => GREATEST(COALESCE(_lease_seconds, 120), 30))
      FROM due
     WHERE d.id = due.id
    RETURNING d.id, d.organization_id, d.endpoint_id, d.event_id, d.event_type, d.payload, d.attempts
  )
  SELECT c.id, c.organization_id, c.endpoint_id, c.event_id, c.event_type, c.payload, c.attempts,
         e.url, s.secret_ciphertext
    FROM claimed c
    JOIN public.webhook_endpoints e ON e.id = c.endpoint_id
    LEFT JOIN public.webhook_endpoint_secrets s ON s.endpoint_id = c.endpoint_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_claim_deliveries(integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_claim_deliveries(integer, integer, uuid) TO service_role;

-- Record: the worker decides WHAT happened (succeeded, retry at T, or out of
-- retries) and this writes it, along with the endpoint's counters, in one
-- statement per table so two runs cannot lose an increment. A delivery that
-- ends failed counts toward switching the endpoint off; a test delivery does
-- not, because pressing the button on a half-configured Zap should not be
-- able to disable the endpoint. Returns whether THIS call switched it off,
-- so the caller notifies exactly once.
CREATE OR REPLACE FUNCTION public.webhook_record_attempt(
  _delivery_id uuid,
  _succeeded boolean,
  _final boolean,
  _next_attempt_at timestamptz,
  _status_code integer,
  _error text,
  _disable_after integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _endpoint uuid;
  _type text;
  _was_enabled boolean;
  _now_enabled boolean;
  _failures integer;
BEGIN
  UPDATE public.webhook_deliveries d
     SET status = CASE WHEN _succeeded THEN 'succeeded' WHEN _final THEN 'failed' ELSE 'pending' END,
         next_attempt_at = CASE WHEN _succeeded OR _final THEN now()
                                ELSE COALESCE(_next_attempt_at, now() + interval '1 minute') END,
         last_status_code = _status_code,
         last_error = CASE WHEN _succeeded THEN NULL ELSE left(_error, 500) END,
         delivered_at = CASE WHEN _succeeded THEN now() ELSE NULL END
   WHERE d.id = _delivery_id
     AND d.status = 'pending'
  RETURNING d.endpoint_id, d.event_type INTO _endpoint, _type;

  IF _endpoint IS NULL THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;

  SELECT e.enabled INTO _was_enabled FROM public.webhook_endpoints e WHERE e.id = _endpoint;

  IF _succeeded THEN
    UPDATE public.webhook_endpoints e
       SET consecutive_failures = 0, last_success_at = now()
     WHERE e.id = _endpoint;
  ELSIF _final AND _type <> 'webhook.test' THEN
    UPDATE public.webhook_endpoints e
       SET consecutive_failures = e.consecutive_failures + 1,
           last_failure_at = now(),
           enabled = CASE WHEN e.consecutive_failures + 1 >= GREATEST(_disable_after, 1) THEN false
                          ELSE e.enabled END,
           disabled_reason = CASE WHEN e.enabled AND e.consecutive_failures + 1 >= GREATEST(_disable_after, 1)
                                  THEN format('Switched off after %s deliveries in a row failed', e.consecutive_failures + 1)
                                  ELSE e.disabled_reason END
     WHERE e.id = _endpoint
    RETURNING e.enabled, e.consecutive_failures INTO _now_enabled, _failures;
  ELSE
    UPDATE public.webhook_endpoints e
       SET last_failure_at = now()
     WHERE e.id = _endpoint;
  END IF;

  RETURN jsonb_build_object(
    'recorded', true,
    'endpoint_id', _endpoint,
    'consecutive_failures', _failures,
    'disabled_now', COALESCE(_was_enabled AND _now_enabled IS FALSE, false)
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_record_attempt(uuid, boolean, boolean, timestamptz, integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_record_attempt(uuid, boolean, boolean, timestamptz, integer, text, integer) TO service_role;

-- Prune: finished deliveries older than 30 days, a bounded batch per call so
-- a backlog is cleared over several minutes rather than in one long lock.
CREATE OR REPLACE FUNCTION public.webhook_prune_deliveries()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  _n integer;
BEGIN
  DELETE FROM public.webhook_deliveries d
   WHERE d.id IN (
     SELECT x.id FROM public.webhook_deliveries x
      WHERE x.status IN ('succeeded', 'failed')
        AND x.next_attempt_at < now() - interval '30 days'
      LIMIT 1000
   );
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END
$fn$;

REVOKE ALL ON FUNCTION public.webhook_prune_deliveries() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_prune_deliveries() TO service_role;

-- ── 7. Schedule the worker ──────────────────────────────────────────────────
--
-- Every minute, and a no-op minute costs one indexed EXISTS: the POST is a
-- SELECT ... FROM the Vault secret WHERE something is due, so with nothing
-- due, or no `cron_service_role_key` in Vault (every local stack), no request
-- is made at all. The canonical host, because Authorization does not survive
-- the redirect from www (20260804160000). 60 seconds for pg_net rather than
-- its default 5: a batch of slow receivers takes longer than 5 seconds, and
-- on Cloudflare a caller that hangs up can take the request down with it.
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule('deliver-webhooks')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deliver-webhooks');
    PERFORM cron.schedule('deliver-webhooks', '* * * * *', $job$
  SELECT public.webhook_prune_deliveries();
  SELECT net.http_post(
      url := 'https://app.houndstack.com/api/public/hooks/webhook-deliveries',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'Authorization', 'Bearer ' || s.decrypted_secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
  ) AS request_id
    FROM vault.decrypted_secrets s
   WHERE s.name = 'cron_service_role_key'
     AND EXISTS (
       SELECT 1
         FROM public.webhook_deliveries d
         JOIN public.webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND e.enabled
     );
  $job$);
  ELSE
    RAISE WARNING 'pg_cron is not installed, so deliver-webhooks was NOT scheduled; webhook deliveries will queue and never be sent';
  END IF;
END
$sched$;

-- ── 8. Check what this file established ─────────────────────────────────────

DO $check$
DECLARE
  _t text;
  _fn text;
  _n integer;
BEGIN
  FOREACH _t IN ARRAY ARRAY['webhook_endpoints', 'webhook_endpoint_secrets', 'webhook_deliveries'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = _t AND c.relrowsecurity) THEN
      RAISE EXCEPTION '% is missing or does not have row level security on', _t;
    END IF;
    IF has_table_privilege('anon', format('public.%I', _t), 'SELECT')
       OR has_table_privilege('anon', format('public.%I', _t), 'INSERT') THEN
      RAISE EXCEPTION 'anon can read or write %', _t;
    END IF;
  END LOOP;

  IF has_table_privilege('authenticated', 'public.webhook_endpoint_secrets', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.webhook_endpoint_secrets'::regclass
                   AND polpermissive) THEN
    RAISE EXCEPTION 'webhook_endpoint_secrets is readable by authenticated or has a policy; it must be deny-all';
  END IF;
  IF has_table_privilege('authenticated', 'public.webhook_endpoints', 'INSERT')
     OR has_column_privilege('authenticated', 'public.webhook_endpoints', 'url', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.webhook_endpoints', 'organization_id', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can create an endpoint or point one somewhere else around the SSRF checks';
  END IF;
  IF has_table_privilege('authenticated', 'public.webhook_deliveries', 'INSERT')
     OR has_table_privilege('authenticated', 'public.webhook_deliveries', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can write the webhook outbox';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                  AND indexname = 'webhook_deliveries_status_next_attempt') THEN
    RAISE EXCEPTION 'the outbox has no (status, next_attempt_at) index; the worker would scan it';
  END IF;

  FOREACH _fn IN ARRAY ARRAY[
    'public.webhook_endpoints_before_update()', 'public.webhook_emit_client()',
    'public.webhook_emit_visit()', 'public.webhook_emit_invoice()',
    'public.webhook_emit_payment()', 'public.webhook_emit_quote()', 'public.webhook_emit_lead()',
    'public.webhook_enqueue(uuid, text, jsonb)',
    'public.webhook_claim_deliveries(integer, integer, uuid)',
    'public.webhook_record_attempt(uuid, boolean, boolean, timestamptz, integer, text, integer)',
    'public.webhook_prune_deliveries()'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) cfg
                    WHERE p.oid = _fn::regprocedure AND cfg LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% has no fixed search_path', _fn;
    END IF;
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon or authenticated', _fn;
    END IF;
  END LOOP;

  SELECT count(*) INTO _n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
     AND t.tgname IN ('webhook_emit_client', 'webhook_emit_visit', 'webhook_emit_invoice_insert',
                      'webhook_emit_invoice_paid', 'webhook_emit_payment_insert',
                      'webhook_emit_payment_succeeded', 'webhook_emit_quote', 'webhook_emit_lead',
                      'webhook_endpoints_before_update');
  IF _n <> 9 THEN
    RAISE EXCEPTION 'expected 9 enabled webhook triggers, found %', _n;
  END IF;
END
$check$;

-- WARNING, not EXCEPTION: see the header. The job is scheduled above when
-- pg_cron exists; saying so if it is not is the operator's cue.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron')
     AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deliver-webhooks' AND active) THEN
    RAISE WARNING 'deliver-webhooks is not scheduled or not active; webhooks will queue and not be sent';
  END IF;
END
$cron$;
