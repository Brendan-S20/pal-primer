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

export const getUnreadNotificationCount = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { count, error } = await (context.supabase as any)
      .from("app_notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null);
    if (error) throw new Error(error.message);
    return { unread: count ?? 0 };
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
