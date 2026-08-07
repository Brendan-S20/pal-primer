import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Reader/mutator server fns for the in-app notification center. All scoped to
// the signed-in user via RLS (recipient_user_id = auth.uid()).

export const listMyNotifications = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await (context.supabase as any)
      .from("app_notifications")
      .select("id, type, title, body, link, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as any[];
    return { notifications: rows, unread: rows.filter((r) => !r.read_at).length };
  });

export const markNotificationRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await (context.supabase as any)
      .from("app_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", data.id)
      .is("read_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await (context.supabase as any)
      .from("app_notifications")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markAllNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await (context.supabase as any)
      .from("app_notifications")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// The notification types a user can mute (label shown in Settings).
export const NOTIFICATION_TYPES: Array<{ type: string; label: string }> = [
  { type: "concern", label: "Client concerns" },
  { type: "payment_failed", label: "Failed client payments" },
  { type: "lead", label: "New website leads" },
  { type: "receptionist_escalation", label: "AI receptionist escalations" },
  { type: "inbound_sms", label: "Texts needing a reply" },
  { type: "teammate_joined", label: "Teammate joined" },
];

export const getNotificationPrefs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await (context.supabase as any)
      .from("app_notification_prefs")
      .select("muted_types")
      .eq("user_id", context.userId)
      .maybeSingle();
    return { mutedTypes: (data?.muted_types as string[]) ?? [], types: NOTIFICATION_TYPES };
  });

export const setNotificationPrefs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ mutedTypes: z.array(z.string().max(64)).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    const allowed = new Set(NOTIFICATION_TYPES.map((t) => t.type));
    const muted = data.mutedTypes.filter((t) => allowed.has(t));
    const { error } = await (context.supabase as any)
      .from("app_notification_prefs")
      .upsert({ user_id: context.userId, muted_types: muted, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
