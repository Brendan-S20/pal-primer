-- An owner could not see the portal.
--
-- "Open portal" on a client opened the customer's portal link, which asks
-- whoever opens it for a one-time code sent to the CUSTOMER. So the owner
-- landed on a sign-in screen for somebody else's phone, and the only way
-- past it was to reveal an office-read code and sign in as the customer,
-- with every button live: skip a visit, change the card, pay an invoice.
--
-- A preview is a portal session a staff member mints for themselves from
-- the client's page. It is marked with who minted it, and the server
-- refuses every portal action on a preview session unless that action
-- explicitly says it only reads (src/lib/portal-auth.server.ts,
-- requirePortalSession). The default is refusal, so a portal action added
-- later is read-only in a preview until somebody decides otherwise.
--
--   portal_sessions.preview_by   null for the customer's own session; the
--                                staff user's id for a preview.
--
-- No FK to auth.users: a preview session lives an hour, and who took it is
-- recorded in the client's Activity, which is the record that matters.
--
-- Replays into an empty database: one nullable column.

ALTER TABLE public.portal_sessions
  ADD COLUMN IF NOT EXISTS preview_by uuid;

COMMENT ON COLUMN public.portal_sessions.preview_by IS
  'Null for a customer''s own portal session. For a staff preview, the staff user who opened it; the server treats such a session as read-only.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'portal_sessions'
       AND column_name = 'preview_by' AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'portal_sessions.preview_by is missing, or has a default that would make a customer''s session a preview';
  END IF;
  -- The column says which sessions are read-only; nobody but the server may
  -- read or write it. RLS on with no policy is what keeps the API out.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.portal_sessions'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.portal_sessions'::regclass) THEN
    RAISE EXCEPTION 'portal_sessions is reachable through the API';
  END IF;
END
$check$;
