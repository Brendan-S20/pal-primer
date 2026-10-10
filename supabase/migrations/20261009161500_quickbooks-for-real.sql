-- QuickBooks Online for real, and Xero gone (owner, 2026-10-09).
--
-- The sync was switched off behind ACCOUNTING_CONNECT_ENABLED and, switched
-- on, would have failed Intuit's app assessment (INV-7 in
-- reports/spec-investigations-2026-10-09.md). This is the database half:
--
--   1. accounting_connections learns its own STATE. A refresh token that is
--      expired or refused (invalid_grant) marks the connection
--      `needs_reconnect`; syncing stops and the app asks a person to connect
--      again. A disconnect, from HoundStack or from inside QuickBooks, deletes
--      the tokens and marks it `disconnected`. Plus the refresh token's own
--      expiry, and the three QuickBooks choices the sync posts through (the
--      service item, the sales-tax item, the deposit account), which replace
--      typed-in account ids that QuickBooks' invoice API does not route by.
--   2. accounting_sync_log records each call's intuit_tid (Intuit's id for
--      the transaction, what their support asks for), HTTP status, error code
--      and attempt count. It becomes read-only to signed-in users and readable
--      only by the office (manage_settings): the server writes it on the
--      service role, and a log a tenant could write is not a log.
--   3. Least privilege on the three tables. Browser sessions could INSERT,
--      UPDATE, DELETE and TRUNCATE all three, anon included, held back only by
--      RLS. Now: oauth_states (the CSRF nonces) is the server's alone;
--      accounting_connections is readable by the office without its two token
--      columns, and writable only in the three mapping columns; the sync log
--      is SELECT only.
--
-- Xero: rows may stay (owner's decision), but their tokens are deleted and
-- they are marked disconnected, so nothing can use them. No enum value is
-- dropped: a value in use cannot be, and nothing reads it now.
--
-- Replays into an empty database: every statement is about columns, grants
-- and policies this file creates or that earlier files create; the UPDATEs
-- find no rows on a fresh build, and the checks assert only what this file
-- establishes.

-- ── 1. connection state ───────────────────────────────────────────────────

ALTER TABLE public.accounting_connections
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'connected',
  ADD COLUMN IF NOT EXISTS status_reason text,
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz,
  ADD COLUMN IF NOT EXISTS refresh_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_item_id text,
  ADD COLUMN IF NOT EXISTS sales_tax_item_id text,
  ADD COLUMN IF NOT EXISTS deposit_account_id text;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.accounting_connections'::regclass
                    AND conname = 'accounting_connections_status_check') THEN
    ALTER TABLE public.accounting_connections
      ADD CONSTRAINT accounting_connections_status_check
      CHECK (status IN ('connected', 'needs_reconnect', 'disconnected'));
  END IF;
END
$constraints$;

COMMENT ON COLUMN public.accounting_connections.status IS
  'connected | needs_reconnect (refresh token expired or refused: syncing stops, the app asks to reconnect) | disconnected (tokens deleted).';
COMMENT ON COLUMN public.accounting_connections.service_item_id IS
  'QuickBooks Item Id every service line posts through. Replaces default_income_account, which the invoice API does not route by.';
COMMENT ON COLUMN public.accounting_connections.sales_tax_item_id IS
  'QuickBooks Item Id the sales-tax line posts through (its account should be the sales-tax liability). Replaces default_sales_tax_account.';
COMMENT ON COLUMN public.accounting_connections.deposit_account_id IS
  'QuickBooks Account Id payments are deposited to; null means Undeposited Funds.';

-- Xero is gone: no tokens left that anything could use.
UPDATE public.accounting_connections
   SET access_token = NULL,
       refresh_token = NULL,
       token_expires_at = NULL,
       status = 'disconnected',
       status_reason = 'Xero support was removed',
       status_changed_at = now(),
       disconnected_at = now()
 WHERE provider = 'xero';

-- A QuickBooks row that never completed a connection is not connected.
UPDATE public.accounting_connections
   SET status = 'disconnected', status_reason = 'never connected', status_changed_at = now()
 WHERE provider = 'quickbooks'
   AND (realm_id IS NULL OR refresh_token IS NULL);

-- A token stored before encryption at rest (not in the `v1.` envelope of
-- src/lib/secret-encryption.server.ts) cannot be encrypted here, because the
-- key lives only in the app. It is deleted and the owner asked to reconnect.
UPDATE public.accounting_connections
   SET access_token = NULL,
       refresh_token = NULL,
       token_expires_at = NULL,
       status = 'needs_reconnect',
       status_reason = 'a token stored without encryption was discarded',
       status_changed_at = now()
 WHERE (access_token IS NOT NULL AND access_token NOT LIKE 'v1.%')
    OR (refresh_token IS NOT NULL AND refresh_token NOT LIKE 'v1.%');

DELETE FROM public.oauth_states WHERE provider = 'xero';

-- ── 2. the sync log ───────────────────────────────────────────────────────

ALTER TYPE public.accounting_entity_type ADD VALUE IF NOT EXISTS 'connection';

ALTER TABLE public.accounting_sync_log
  ADD COLUMN IF NOT EXISTS intuit_tid text,
  ADD COLUMN IF NOT EXISTS http_status integer,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS attempts integer;

COMMENT ON COLUMN public.accounting_sync_log.intuit_tid IS
  'The intuit_tid response header of the QuickBooks call this row records. Give it to Intuit support with the time.';

DROP POLICY IF EXISTS "Managers read sync log" ON public.accounting_sync_log;
DROP POLICY IF EXISTS "Managers write sync log" ON public.accounting_sync_log;
DROP POLICY IF EXISTS "Managers write sync log (insert)" ON public.accounting_sync_log;
DROP POLICY IF EXISTS "Managers write sync log (update)" ON public.accounting_sync_log;
DROP POLICY IF EXISTS "Managers write sync log (delete)" ON public.accounting_sync_log;
DROP POLICY IF EXISTS "accounting sync log: the office reads" ON public.accounting_sync_log;
CREATE POLICY "accounting sync log: the office reads"
  ON public.accounting_sync_log FOR SELECT TO authenticated
  USING (public.has_permission((SELECT auth.uid()), org_id, 'manage_settings'));

ALTER TABLE public.accounting_sync_log ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.accounting_sync_log');

-- ── 3. least privilege ────────────────────────────────────────────────────

REVOKE ALL ON public.accounting_sync_log FROM anon, authenticated;
GRANT SELECT ON public.accounting_sync_log TO authenticated;
GRANT ALL ON public.accounting_sync_log TO service_role;

ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.oauth_states');
REVOKE ALL ON public.oauth_states FROM anon, authenticated;
GRANT ALL ON public.oauth_states TO service_role;
ALTER TABLE public.oauth_states ALTER COLUMN expires_at SET DEFAULT now() + interval '10 minutes';

ALTER TABLE public.accounting_connections ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.accounting_connections');
REVOKE ALL ON public.accounting_connections FROM anon, authenticated;
-- Every column but the two tokens. Connecting, refreshing and disconnecting
-- all run on the service role.
GRANT SELECT (
  id, org_id, provider, realm_id, tenant_id, token_expires_at, refresh_token_expires_at,
  default_income_account, default_ar_account, default_payment_account, default_sales_tax_account,
  auto_sync, connected_at, last_sync_at, created_at, updated_at,
  status, status_reason, status_changed_at, disconnected_at,
  service_item_id, sales_tax_item_id, deposit_account_id
) ON public.accounting_connections TO authenticated;
GRANT UPDATE (service_item_id, sales_tax_item_id, deposit_account_id)
  ON public.accounting_connections TO authenticated;
GRANT ALL ON public.accounting_connections TO service_role;

-- ── what this file establishes ────────────────────────────────────────────

DO $check$
DECLARE
  _n integer;
BEGIN
  -- No token outside the encryption envelope, and none on a Xero row.
  SELECT count(*) INTO _n FROM public.accounting_connections
   WHERE (access_token IS NOT NULL AND access_token NOT LIKE 'v1.%')
      OR (refresh_token IS NOT NULL AND refresh_token NOT LIKE 'v1.%')
      OR (provider = 'xero' AND (access_token IS NOT NULL OR refresh_token IS NOT NULL));
  IF _n > 0 THEN
    RAISE EXCEPTION '% accounting connection(s) still hold a plaintext or Xero token', _n;
  END IF;

  -- A browser session cannot read a token, or write anything but the mapping.
  IF has_column_privilege('authenticated', 'public.accounting_connections', 'access_token', 'SELECT')
     OR has_column_privilege('authenticated', 'public.accounting_connections', 'refresh_token', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated can still read the QuickBooks tokens';
  END IF;
  IF has_column_privilege('authenticated', 'public.accounting_connections', 'realm_id', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.accounting_connections', 'INSERT')
     OR has_table_privilege('authenticated', 'public.accounting_connections', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated can still write accounting_connections beyond the mapping';
  END IF;

  -- Nobody signed in or out can touch the CSRF states.
  IF has_table_privilege('authenticated', 'public.oauth_states', 'SELECT')
     OR has_table_privilege('anon', 'public.oauth_states', 'SELECT') THEN
    RAISE EXCEPTION 'oauth_states is readable by a browser session';
  END IF;

  -- The sync log: read-only to signed-in users, and only through one
  -- permissive SELECT policy (the RESTRICTIVE two-step policy is not counted).
  IF has_table_privilege('authenticated', 'public.accounting_sync_log', 'INSERT')
     OR has_table_privilege('authenticated', 'public.accounting_sync_log', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.accounting_sync_log', 'DELETE')
     OR has_table_privilege('anon', 'public.accounting_sync_log', 'SELECT') THEN
    RAISE EXCEPTION 'accounting_sync_log is writable by a browser session, or readable signed out';
  END IF;
  SELECT count(*) INTO _n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'accounting_sync_log' AND permissive = 'PERMISSIVE';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'accounting_sync_log has % permissive policies, expected exactly one (SELECT)', _n;
  END IF;
  SELECT count(*) INTO _n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'accounting_sync_log' AND permissive = 'RESTRICTIVE';
  IF _n < 1 THEN
    RAISE EXCEPTION 'accounting_sync_log lost its two-step sign-in policy';
  END IF;
END
$check$;
