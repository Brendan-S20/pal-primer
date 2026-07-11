-- Per-user notification preferences: which in-app notification types to mute.
-- Applied to live via Supabase MCP 2026-07-11.
CREATE TABLE IF NOT EXISTS public.app_notification_prefs (
  user_id uuid PRIMARY KEY,
  muted_types text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_notification_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_notification_prefs_select_own ON public.app_notification_prefs;
CREATE POLICY app_notification_prefs_select_own ON public.app_notification_prefs
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS app_notification_prefs_upsert_own ON public.app_notification_prefs;
CREATE POLICY app_notification_prefs_upsert_own ON public.app_notification_prefs
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
