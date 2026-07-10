-- In-app notification center. Rows are pre-fanned-out per recipient user so RLS
-- is trivial (recipient sees only their own). Inserted service-role only.
-- Applied to live via Supabase MCP 2026-07-10.
CREATE TABLE IF NOT EXISTS public.app_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_notifications_select_own ON public.app_notifications;
CREATE POLICY app_notifications_select_own ON public.app_notifications
  FOR SELECT USING (recipient_user_id = auth.uid());

DROP POLICY IF EXISTS app_notifications_update_own ON public.app_notifications;
CREATE POLICY app_notifications_update_own ON public.app_notifications
  FOR UPDATE USING (recipient_user_id = auth.uid()) WITH CHECK (recipient_user_id = auth.uid());

CREATE INDEX IF NOT EXISTS app_notifications_recipient_idx
  ON public.app_notifications (recipient_user_id, read_at, created_at DESC);
