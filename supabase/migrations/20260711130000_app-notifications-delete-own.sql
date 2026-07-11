-- Notification center (punch list #14): let users delete their own
-- notifications. Select/update-own policies existed; delete did not.
create policy app_notifications_delete_own on public.app_notifications
  for delete using (recipient_user_id = auth.uid());
