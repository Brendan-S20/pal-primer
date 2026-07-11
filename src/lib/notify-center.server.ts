// Server-only helpers to emit in-app notifications. Rows are fanned out one per
// recipient user so RLS stays trivial. Call from webhooks / RPCs / server fns
// (best-effort — a notification failure must never block the triggering action).

type NotifyInput = {
  orgId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
};

/** Notify specific users by id. */
export async function notifyUsers(userIds: string[], n: NotifyInput): Promise<void> {
  let ids = Array.from(new Set(userIds.filter(Boolean)));
  if (!ids.length) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Drop recipients who muted this notification type.
  const { data: prefs } = await (supabaseAdmin as any)
    .from("app_notification_prefs")
    .select("user_id, muted_types")
    .in("user_id", ids);
  const muted = new Set(
    (prefs ?? []).filter((p: any) => (p.muted_types ?? []).includes(n.type)).map((p: any) => p.user_id),
  );
  ids = ids.filter((uid) => !muted.has(uid));
  if (!ids.length) return;
  const rows = ids.map((uid) => ({
    organization_id: n.orgId,
    recipient_user_id: uid,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    link: n.link ?? null,
  }));
  const { error } = await (supabaseAdmin as any).from("app_notifications").insert(rows);
  if (error) console.error("notifyUsers insert failed", error.message);
}

/** Notify every user in the org holding one of the given roles. */
export async function notifyRoles(
  roles: Array<"owner" | "office_manager" | "dispatcher" | "tech">,
  n: NotifyInput,
): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("user_id, role")
    .eq("organization_id", n.orgId)
    .in("role", roles);
  await notifyUsers((data ?? []).map((r: any) => r.user_id), n);
}
