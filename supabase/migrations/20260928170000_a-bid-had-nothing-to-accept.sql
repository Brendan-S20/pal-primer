-- A bid had nothing to accept.
--
-- Found 2026-09-28 by the product review (a Jobber-switcher persona and a
-- market research pass): the one feature a switching shop said it could not
-- live without. A price in this product was only ever a number computed from
-- zone pricing. An HOA board, a property manager, or a homeowner who wants a
-- price in writing before they commit had no document to look at and nothing
-- to say yes to. Jobber's flow is the one they know: write a quote, send it
-- by link, the customer approves it without a password, and it becomes work.
--
-- Version one, deliberately not Jobber's whole estimates module:
--
--   quotes              one row per quote. For an existing client
--                       (client_id) or for a prospect who is not a client yet
--                       (prospect_name / _email / _phone, and lead_id when it
--                       came from a lead). Numbered per organization like
--                       invoices (20260928120000): organizations.next_quote_number
--                       is the counter, taken by UPDATE ... RETURNING on the
--                       org row so two quotes created at once serialize on
--                       that lock and never share a number. Labelled Q-1001.
--   quote_line_items    quantity x unit price = line total, with a CHECK that
--                       says so, and a flag for a per-visit recurring price as
--                       opposed to a one-time charge.
--
-- Status: draft -> sent -> accepted | declined | expired.
--   * A draft is the office's. Nothing about it is visible outside the org.
--   * Once sent, what the customer reads is frozen: the lines can only be
--     written while the quote is a draft (the line policies say so), and a
--     trigger refuses edits to the quote's own content after it leaves
--     draft. The document somebody signed is the document on file.
--   * Only the customer accepts or declines. The same trigger refuses a
--     direct write of accepted/declined, or of the signature fields, from
--     the API roles; the one path that writes them is public_quote_respond.
--   * A sent quote past its valid_until date reads as expired (on the
--     organization's calendar) and cannot be accepted. The office can also
--     withdraw a sent quote, which stores status = 'expired'.
--
-- ACCESS
--
--   Staff: RLS mirrors invoices exactly. Read with manage_client_billing or
--   view_financials; write with manage_client_billing; delete only a draft.
--   Separate insert / update / delete policies rather than FOR ALL, so no two
--   permissive policies answer the same question for the same role
--   (20260810120000). anon has no privilege on either table at all.
--
--   The customer: ONLY through two SECURITY DEFINER functions, reached the
--   way the public invoice page reaches its invoice. getPublicInvoice runs as
--   a server function with no session, holding the service-role client, and
--   the unguessable token is the capability. So these two are granted to
--   service_role and to nobody else, like portal_request_reclean
--   (20260928110000):
--
--     public_quote_document(_token)   the quote, the business's name and
--                                     contact, and the lines. NULL for an
--                                     unknown token AND for a draft, so a
--                                     draft's link is indistinguishable from
--                                     a mistyped one.
--     public_quote_respond(_token, _accept, _name, _reason)
--                                     accepts (with a typed full name, which
--                                     is the signature) or declines (with an
--                                     optional reason) a SENT, unexpired
--                                     quote, exactly once. Idempotent: the
--                                     same answer again returns the first
--                                     answer, unchanged, with changed=false.
--                                     The opposite answer is refused.
--
--   Not named public_quote: that name is the signup page's ZIP price quote
--   (20260717140000), granted to anon. An overload of it would sit one
--   argument list away from an anon-callable function of the same name.
--
-- organizations.notify_email_quote_sent is the switch enqueueAppEmail reads,
-- as it does for every other customer email. It defaults ON for everyone,
-- existing organizations included: unlike the visit reminder (20260928040000)
-- nothing is sent unless somebody presses Send on a quote.
--
-- Replays into an empty database: two columns, two tables, their indexes,
-- policies and grants, two trigger functions and two public functions. Every
-- assertion in the DO block below is about what this file establishes; none
-- needs a tenant or a row.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS next_quote_number integer NOT NULL DEFAULT 1001;
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_email_quote_sent boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organizations.next_quote_number IS
  'The number the next quote will get (Q-1001). Advanced only by quotes_before_write().';
COMMENT ON COLUMN public.organizations.notify_email_quote_sent IS
  'Email a quote to the customer when the office presses Send. Every quote email is an explicit user action.';

-- ── quotes ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Assigned by quotes_before_write() whatever the caller sends. NOT NULL is
  -- checked after BEFORE triggers run, so the counter always gets there first.
  number integer NOT NULL,
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  prospect_name text,
  prospect_email text,
  prospect_phone text,
  status text NOT NULL DEFAULT 'draft',
  title text,
  message text,
  valid_until date,
  public_token uuid NOT NULL DEFAULT gen_random_uuid(),
  sent_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  accepted_name text,
  decline_reason text,
  converted_at timestamptz,
  converted_client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quotes_public_token_key UNIQUE (public_token),
  CONSTRAINT quotes_status_check CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
  -- A quote is addressed to somebody: a client, or a prospect with a name.
  CONSTRAINT quotes_has_a_recipient CHECK (
    client_id IS NOT NULL OR char_length(btrim(COALESCE(prospect_name, ''))) > 0
  ),
  -- Anything past draft has been sent, and says when.
  CONSTRAINT quotes_sent_says_when CHECK (status = 'draft' OR sent_at IS NOT NULL),
  -- An acceptance carries its signature, a decline its time.
  CONSTRAINT quotes_accepted_is_signed CHECK (
    status <> 'accepted'
    OR (accepted_at IS NOT NULL AND char_length(btrim(COALESCE(accepted_name, ''))) >= 2)
  ),
  CONSTRAINT quotes_declined_says_when CHECK (status <> 'declined' OR declined_at IS NOT NULL),
  CONSTRAINT quotes_field_lengths CHECK (
    char_length(COALESCE(title, '')) <= 200
    AND char_length(COALESCE(message, '')) <= 4000
    AND char_length(COALESCE(prospect_name, '')) <= 200
    AND char_length(COALESCE(prospect_email, '')) <= 320
    AND char_length(COALESCE(prospect_phone, '')) <= 40
    AND char_length(COALESCE(accepted_name, '')) <= 120
    AND char_length(COALESCE(decline_reason, '')) <= 1000
  )
);

COMMENT ON TABLE public.quotes IS
  'A priced offer to a client or a prospect, sent by link and accepted or declined by the customer without signing in. The customer reaches it only through public_quote_document / public_quote_respond.';
COMMENT ON COLUMN public.quotes.public_token IS
  'The capability in the customer''s link (/q/<token>). Never changes.';
COMMENT ON COLUMN public.quotes.accepted_name IS
  'The full name the customer typed to accept: the acceptance signature.';
COMMENT ON COLUMN public.quotes.status IS
  'draft | sent | accepted | declined | expired. A sent quote past valid_until on the org''s calendar reads as expired even while this still says sent.';

CREATE UNIQUE INDEX IF NOT EXISTS quotes_org_number_key ON public.quotes (organization_id, number);
-- The list reads an org's quotes newest first, filtered by status.
CREATE INDEX IF NOT EXISTS quotes_org_status_created ON public.quotes (organization_id, status, created_at DESC);
-- Every foreign key indexed. organization_id leads the two above.
CREATE INDEX IF NOT EXISTS quotes_client_id ON public.quotes (client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS quotes_lead_id ON public.quotes (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS quotes_converted_client_id ON public.quotes (converted_client_id)
  WHERE converted_client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS quotes_created_by ON public.quotes (created_by) WHERE created_by IS NOT NULL;

-- ── quote_line_items ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.quote_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity numeric(10,2) NOT NULL DEFAULT 1,
  unit_amount_cents integer NOT NULL,
  amount_cents integer NOT NULL,
  -- false: a one-time charge (an initial cleanup). true: a price per visit.
  recurring boolean NOT NULL DEFAULT false,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_line_items_description_check CHECK (
    char_length(btrim(description)) BETWEEN 1 AND 300
  ),
  CONSTRAINT quote_line_items_quantity_check CHECK (quantity > 0 AND quantity <= 10000),
  CONSTRAINT quote_line_items_unit_amount_check CHECK (unit_amount_cents BETWEEN 0 AND 10000000),
  -- The line total is the arithmetic, not a second opinion about it. round()
  -- on numeric rounds half away from zero; src/lib/quotes.ts does the same.
  CONSTRAINT quote_line_items_amount_is_quantity_times_price CHECK (
    amount_cents = round(quantity * unit_amount_cents)
  )
);

COMMENT ON TABLE public.quote_line_items IS
  'Lines on a quote. Writable only while the quote is a draft.';

CREATE INDEX IF NOT EXISTS quote_line_items_quote_sort ON public.quote_line_items (quote_id, sort);

-- ── Trigger 1: numbering, and every reference stays inside the tenant ───────
--
-- SECURITY DEFINER because it advances organizations.next_quote_number, which
-- the office's own role has no business writing. The reference checks live
-- here too, with the definer's full view: a client_id from another tenant
-- would otherwise be a quote the office can email to somebody else's
-- customer, since the email is sent with the service-role client.

CREATE OR REPLACE FUNCTION public.quotes_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.organizations
       SET next_quote_number = next_quote_number + 1
     WHERE id = NEW.organization_id
     RETURNING next_quote_number - 1 INTO NEW.number;
  ELSE
    -- Identity never changes: the number on the customer's copy, the link in
    -- their inbox, and whose quote it is.
    NEW.number := OLD.number;
    NEW.public_token := OLD.public_token;
    NEW.organization_id := OLD.organization_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
  END IF;

  IF NEW.client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.clients c WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'That client is not in this organization';
  END IF;
  IF NEW.converted_client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.clients c
     WHERE c.id = NEW.converted_client_id AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'That client is not in this organization';
  END IF;
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads l WHERE l.id = NEW.lead_id AND l.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'That lead is not in this organization';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.quotes_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS quotes_before_write ON public.quotes;
CREATE TRIGGER quotes_before_write
  BEFORE INSERT OR UPDATE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quotes_before_write();

-- ── Trigger 2: what was sent stays sent, and only the customer answers ──────
--
-- SECURITY INVOKER on purpose. It asks current_user who is writing, and inside
-- a definer function that would always be the function's owner. As invoker it
-- sees 'authenticated' for a PostgREST write from the office, and the owner of
-- public_quote_respond when the customer's answer is being recorded.

CREATE OR REPLACE FUNCTION public.quotes_guard_answer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status <> 'draft'
     AND (NEW.client_id, NEW.lead_id, NEW.prospect_name, NEW.prospect_email, NEW.prospect_phone,
          NEW.title, NEW.message, NEW.valid_until)
         IS DISTINCT FROM
         (OLD.client_id, OLD.lead_id, OLD.prospect_name, OLD.prospect_email, OLD.prospect_phone,
          OLD.title, OLD.message, OLD.valid_until) THEN
    RAISE EXCEPTION 'A quote cannot be edited once it has been sent. Duplicate it into a new draft instead.';
  END IF;

  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'A sent quote cannot go back to draft. Duplicate it into a new draft instead.';
  END IF;

  IF current_user IN ('authenticated', 'anon') AND (
       (NEW.status IN ('accepted', 'declined') AND NEW.status IS DISTINCT FROM OLD.status)
    OR (OLD.status IN ('accepted', 'declined') AND NEW.status IS DISTINCT FROM OLD.status)
    OR (NEW.accepted_at, NEW.accepted_name, NEW.declined_at, NEW.decline_reason)
       IS DISTINCT FROM (OLD.accepted_at, OLD.accepted_name, OLD.declined_at, OLD.decline_reason)
  ) THEN
    RAISE EXCEPTION 'Only the customer can accept or decline a quote, from its link.';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.quotes_guard_answer() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS quotes_guard_answer ON public.quotes;
CREATE TRIGGER quotes_guard_answer
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.quotes_guard_answer();

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_line_items ENABLE ROW LEVEL SECURITY;

-- The default privileges on public hand every new table to anon and
-- authenticated with ALL, TRUNCATE included, and TRUNCATE does not ask RLS.
-- Taken back, and then only the four row verbs given to the office's role.
REVOKE ALL ON public.quotes FROM anon, authenticated;
REVOKE ALL ON public.quote_line_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quotes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quote_line_items TO authenticated;
GRANT ALL ON public.quotes TO service_role;
GRANT ALL ON public.quote_line_items TO service_role;

DROP POLICY IF EXISTS "quotes readable by billing and finance roles" ON public.quotes;
CREATE POLICY "quotes readable by billing and finance roles" ON public.quotes
  FOR SELECT TO authenticated
  USING (
    public.has_permission((SELECT auth.uid()), organization_id, 'manage_client_billing')
    OR public.has_permission((SELECT auth.uid()), organization_id, 'view_financials')
  );

DROP POLICY IF EXISTS "quotes writable by billing managers (insert)" ON public.quotes;
CREATE POLICY "quotes writable by billing managers (insert)" ON public.quotes
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission((SELECT auth.uid()), organization_id, 'manage_client_billing'));

DROP POLICY IF EXISTS "quotes writable by billing managers (update)" ON public.quotes;
CREATE POLICY "quotes writable by billing managers (update)" ON public.quotes
  FOR UPDATE TO authenticated
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'manage_client_billing'))
  WITH CHECK (public.has_permission((SELECT auth.uid()), organization_id, 'manage_client_billing'));

-- Only a draft can be deleted. A quote the customer may have read is a record.
DROP POLICY IF EXISTS "quotes writable by billing managers (delete)" ON public.quotes;
CREATE POLICY "quotes writable by billing managers (delete)" ON public.quotes
  FOR DELETE TO authenticated
  USING (
    status = 'draft'
    AND public.has_permission((SELECT auth.uid()), organization_id, 'manage_client_billing')
  );

DROP POLICY IF EXISTS "quote lines readable via parent quote" ON public.quote_line_items;
CREATE POLICY "quote lines readable via parent quote" ON public.quote_line_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.quotes q
     WHERE q.id = quote_line_items.quote_id
       AND (public.has_permission((SELECT auth.uid()), q.organization_id, 'manage_client_billing')
            OR public.has_permission((SELECT auth.uid()), q.organization_id, 'view_financials'))
  ));

DROP POLICY IF EXISTS "quote lines writable on a draft (insert)" ON public.quote_line_items;
CREATE POLICY "quote lines writable on a draft (insert)" ON public.quote_line_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.quotes q
     WHERE q.id = quote_line_items.quote_id
       AND q.status = 'draft'
       AND public.has_permission((SELECT auth.uid()), q.organization_id, 'manage_client_billing')
  ));

DROP POLICY IF EXISTS "quote lines writable on a draft (update)" ON public.quote_line_items;
CREATE POLICY "quote lines writable on a draft (update)" ON public.quote_line_items
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.quotes q
     WHERE q.id = quote_line_items.quote_id
       AND q.status = 'draft'
       AND public.has_permission((SELECT auth.uid()), q.organization_id, 'manage_client_billing')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.quotes q
     WHERE q.id = quote_line_items.quote_id
       AND q.status = 'draft'
       AND public.has_permission((SELECT auth.uid()), q.organization_id, 'manage_client_billing')
  ));

DROP POLICY IF EXISTS "quote lines writable on a draft (delete)" ON public.quote_line_items;
CREATE POLICY "quote lines writable on a draft (delete)" ON public.quote_line_items
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.quotes q
     WHERE q.id = quote_line_items.quote_id
       AND q.status = 'draft'
       AND public.has_permission((SELECT auth.uid()), q.organization_id, 'manage_client_billing')
  ));

-- ── public_quote_document: what the customer's link shows ───────────────────

CREATE OR REPLACE FUNCTION public.public_quote_document(_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _q public.quotes%ROWTYPE;
  _org record;
  _recipient text;
  _today date;
  _status text;
BEGIN
  IF _token IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO _q FROM public.quotes WHERE public_token = _token;
  -- A draft is not published. NULL either way, so a draft's link cannot be
  -- told apart from a mistyped one.
  IF _q.id IS NULL OR _q.status = 'draft' THEN
    RETURN NULL;
  END IF;

  SELECT name, contact_email, contact_phone, timezone, currency INTO _org
    FROM public.organizations WHERE id = _q.organization_id;

  SELECT display_name INTO _recipient FROM public.clients WHERE id = _q.client_id;
  _recipient := COALESCE(_recipient, _q.prospect_name);

  -- Expiry is a day on the business's calendar, not the server's.
  _today := (now() AT TIME ZONE COALESCE(NULLIF(_org.timezone, ''), 'America/Chicago'))::date;
  _status := CASE
    WHEN _q.status = 'sent' AND _q.valid_until IS NOT NULL AND _q.valid_until < _today THEN 'expired'
    ELSE _q.status
  END;

  RETURN jsonb_build_object(
    'number', _q.number,
    'status', _status,
    'title', _q.title,
    'message', _q.message,
    'valid_until', _q.valid_until,
    'sent_at', _q.sent_at,
    'accepted_at', _q.accepted_at,
    'accepted_name', _q.accepted_name,
    'declined_at', _q.declined_at,
    'decline_reason', _q.decline_reason,
    'recipient_name', _recipient,
    'org_name', _org.name,
    'org_email', _org.contact_email,
    'org_phone', _org.contact_phone,
    'org_timezone', _org.timezone,
    'currency', COALESCE(_org.currency, 'usd'),
    'lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'description', li.description,
               'quantity', li.quantity,
               'unit_amount_cents', li.unit_amount_cents,
               'amount_cents', li.amount_cents,
               'recurring', li.recurring
             ) ORDER BY li.sort, li.created_at, li.id)
        FROM public.quote_line_items li
       WHERE li.quote_id = _q.id
    ), '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.public_quote_document(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_quote_document(uuid) TO service_role;

-- ── public_quote_respond: the customer's answer, exactly once ───────────────

CREATE OR REPLACE FUNCTION public.public_quote_respond(
  _token uuid,
  _accept boolean,
  _name text,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _q public.quotes%ROWTYPE;
  _tz text;
  _today date;
  _signature text;
  _changed boolean := false;
BEGIN
  IF _token IS NULL THEN
    RAISE EXCEPTION 'quote_not_found';
  END IF;
  IF _accept IS NULL THEN
    RAISE EXCEPTION 'answer_required';
  END IF;

  -- Locked, so two taps (or two devices) take turns: the second one finds the
  -- first one's answer below and returns it.
  SELECT * INTO _q FROM public.quotes WHERE public_token = _token FOR UPDATE;
  IF _q.id IS NULL OR _q.status = 'draft' THEN
    RAISE EXCEPTION 'quote_not_found';
  END IF;

  -- The same answer again is the first answer, not an error and not a second
  -- timestamp. The opposite answer is refused: a signed quote is not undone
  -- from a link, and a declined one is re-sent as a new quote.
  IF _q.status = 'accepted' THEN
    IF NOT _accept THEN RAISE EXCEPTION 'quote_already_accepted'; END IF;
  ELSIF _q.status = 'declined' THEN
    IF _accept THEN RAISE EXCEPTION 'quote_already_declined'; END IF;
  ELSE
    -- Withdrawn by the office, or past its date on the business's calendar.
    SELECT timezone INTO _tz FROM public.organizations WHERE id = _q.organization_id;
    _today := (now() AT TIME ZONE COALESCE(NULLIF(_tz, ''), 'America/Chicago'))::date;
    IF _q.status = 'expired' OR (_q.valid_until IS NOT NULL AND _q.valid_until < _today) THEN
      RAISE EXCEPTION 'quote_expired';
    END IF;
    IF _q.status <> 'sent' THEN
      RAISE EXCEPTION 'quote_not_found';
    END IF;

    IF _accept THEN
      _signature := btrim(regexp_replace(COALESCE(_name, ''), '\s+', ' ', 'g'));
      IF char_length(_signature) < 2 OR char_length(_signature) > 120 THEN
        RAISE EXCEPTION 'signature_required';
      END IF;
      UPDATE public.quotes
         SET status = 'accepted', accepted_at = now(), accepted_name = _signature
       WHERE id = _q.id
       RETURNING * INTO _q;
    ELSE
      UPDATE public.quotes
         SET status = 'declined', declined_at = now(),
             decline_reason = left(NULLIF(btrim(COALESCE(_reason, '')), ''), 1000)
       WHERE id = _q.id
       RETURNING * INTO _q;
    END IF;
    _changed := true;
  END IF;

  RETURN jsonb_build_object(
    'quote_id', _q.id,
    'organization_id', _q.organization_id,
    'client_id', _q.client_id,
    'number', _q.number,
    'status', _q.status,
    'accepted_at', _q.accepted_at,
    'accepted_name', _q.accepted_name,
    'declined_at', _q.declined_at,
    'decline_reason', _q.decline_reason,
    'recipient_name', COALESCE(
      (SELECT display_name FROM public.clients WHERE id = _q.client_id), _q.prospect_name),
    'changed', _changed
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.public_quote_respond(uuid, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_quote_respond(uuid, boolean, text, text) TO service_role;

-- ── What this file establishes ──────────────────────────────────────────────
DO $check$
DECLARE
  _t text;
  _fn text;
  _fk record;
BEGIN
  FOREACH _t IN ARRAY ARRAY['public.quotes', 'public.quote_line_items'] LOOP
    IF to_regclass(_t) IS NULL THEN
      RAISE EXCEPTION '% was not created', _t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = _t::regclass) THEN
      RAISE EXCEPTION 'RLS is not enabled on %', _t;
    END IF;
    -- Nothing is readable by anon: not by policy, and not by privilege.
    IF has_table_privilege('anon', _t, 'SELECT')
       OR has_table_privilege('anon', _t, 'INSERT')
       OR has_table_privilege('anon', _t, 'UPDATE')
       OR has_table_privilege('anon', _t, 'DELETE') THEN
      RAISE EXCEPTION 'anon holds a privilege on %', _t;
    END IF;
    IF has_table_privilege('authenticated', _t, 'TRUNCATE') THEN
      RAISE EXCEPTION 'authenticated can TRUNCATE %, which RLS does not see', _t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = split_part(_t, '.', 2)
                  AND ('anon' = ANY (roles) OR 'public' = ANY (roles))) THEN
      RAISE EXCEPTION '% has a policy for anon or public', _t;
    END IF;
    -- One question per command: no FOR ALL beside a FOR SELECT.
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = split_part(_t, '.', 2) AND cmd = 'ALL') THEN
      RAISE EXCEPTION '% has a FOR ALL policy', _t;
    END IF;

    -- Every foreign key has an index that leads with its column.
    FOR _fk IN
      SELECT con.conname, con.conkey[1] AS attnum
        FROM pg_constraint con
       WHERE con.conrelid = _t::regclass AND con.contype = 'f'
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_index i WHERE i.indrelid = _t::regclass AND i.indkey[0] = _fk.attnum
      ) THEN
        RAISE EXCEPTION 'foreign key % on % has no index', _fk.conname, _t;
      END IF;
    END LOOP;
  END LOOP;

  -- Writes are gated on the billing permission, never on bare membership.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename IN ('quotes', 'quote_line_items')
                AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
                AND COALESCE(qual, '') || COALESCE(with_check, '') !~ 'manage_client_billing') THEN
    RAISE EXCEPTION 'a quote write policy does not ask for manage_client_billing';
  END IF;
  -- A draft is the only quote that can be deleted, and the only one whose
  -- lines can change.
  IF (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quotes'
        AND cmd = 'DELETE') !~ 'draft' THEN
    RAISE EXCEPTION 'a sent quote can be deleted';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'quote_line_items'
                AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
                AND COALESCE(qual, '') || COALESCE(with_check, '') !~ 'draft') THEN
    RAISE EXCEPTION 'quote lines can be written after the quote was sent';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'next_quote_number' AND is_nullable = 'NO' AND column_default = '1001'
  ) THEN
    RAISE EXCEPTION 'organizations.next_quote_number is missing, nullable, or does not start at 1001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'notify_email_quote_sent' AND is_nullable = 'NO' AND column_default = 'true'
  ) THEN
    RAISE EXCEPTION 'organizations.notify_email_quote_sent is missing or does not default to true';
  END IF;

  IF NOT (SELECT indisunique FROM pg_index WHERE indexrelid = 'public.quotes_org_number_key'::regclass) THEN
    RAISE EXCEPTION 'quote numbers are not unique per organization';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.quotes'::regclass AND conname = 'quotes_public_token_key'
                    AND contype = 'u') THEN
    RAISE EXCEPTION 'quotes.public_token is not unique';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.quote_line_items'::regclass
         AND conname = 'quote_line_items_amount_is_quantity_times_price'))
     !~ 'round\(\(quantity \* \(?unit_amount_cents' THEN
    RAISE EXCEPTION 'quote_line_items does not check amount_cents = round(quantity * unit_amount_cents)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'quotes_before_write'
                   AND tgrelid = 'public.quotes'::regclass) THEN
    RAISE EXCEPTION 'quotes_before_write is not attached';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'quotes_guard_answer'
                   AND tgrelid = 'public.quotes'::regclass) THEN
    RAISE EXCEPTION 'quotes_guard_answer is not attached';
  END IF;
  -- The guard reads current_user, which only means the writer when it runs
  -- as the invoker.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.quotes_guard_answer()'::regprocedure) THEN
    RAISE EXCEPTION 'quotes_guard_answer is SECURITY DEFINER, so current_user is always its owner';
  END IF;

  FOREACH _fn IN ARRAY ARRAY['public.quotes_before_write()', 'public.quotes_guard_answer()'] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'trigger function % is executable by an API role', _fn;
    END IF;
  END LOOP;

  FOREACH _fn IN ARRAY ARRAY[
    'public.public_quote_document(uuid)',
    'public.public_quote_respond(uuid, boolean, text, text)'
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
    -- The public page reaches these through a server function holding the
    -- service-role client, exactly as getPublicInvoice reaches invoices.
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute %', _fn;
    END IF;
    IF has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated can execute %; the public page reaches it only through service_role', _fn;
    END IF;
    IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute %', _fn;
    END IF;
  END LOOP;

  -- Both public functions refuse a draft, and the answer is taken under a lock.
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.public_quote_document(uuid)'::regprocedure)
       !~ 'status = ''draft''' THEN
    RAISE EXCEPTION 'public_quote_document does not refuse a draft';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.public_quote_respond(uuid, boolean, text, text)'::regprocedure)
       !~ 'FOR UPDATE' THEN
    RAISE EXCEPTION 'public_quote_respond does not lock the quote it answers';
  END IF;
END
$check$;
