import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AuthedContext } from "@/lib/server-fn-context";
import { serviceLinesOrDefault, type ServiceLine } from "@/lib/service-lines";

// Reader/mutator server fns for the in-app notification center. All scoped to
// the signed-in user via RLS (recipient_user_id = auth.uid()).

export const listMyNotifications = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadMyNotifications(context));

/** listMyNotifications's answer, also asked by getShellContext. */
export const loadMyNotifications = createServerOnlyFn(async (context: AuthedContext) => {
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
  // A quote request or an online signup from the public form
  // (src/lib/lead-notify.server.ts), to everyone who works Leads.
  { type: "lead", label: "New website leads" },
  { type: "quote_response", label: "Quotes accepted or declined" },
  { type: "receptionist_escalation", label: "AI receptionist escalations" },
  // A visit booked, or asked for, by text (src/lib/receptionist-booking.ts).
  { type: "receptionist_booking", label: "Visits the AI receptionist booked or asked for" },
  { type: "inbound_sms", label: "Texts needing a reply" },
  // The business's own texting number, approved or rejected by carriers
  // (src/lib/twilio-provisioning.server.ts), to the owner.
  { type: "texting_approved", label: "Texting number approved" },
  { type: "texting_rejected", label: "Texting registration rejected" },
  { type: "teammate_joined", label: "Teammate joined" },
  { type: "field_collection", label: "Cash or checks collected in the field" },
  { type: "webhook_disabled", label: "A webhook switched off after failing" },
  // The field (src/lib/field-notify.server.ts). The first four go to the
  // tech whose day it is, in their own language; the last three to the
  // owner, office managers and dispatchers.
  { type: "route_changed", label: "Changes to my route for today or tomorrow" },
  { type: "route_stop_added", label: "A stop added to my day" },
  { type: "route_stop_removed", label: "A stop taken off my day" },
  { type: "visit_access_changed", label: "Gate code or access changed for a stop today" },
  { type: "visit_skipped", label: "A tech skipped a stop" },
  { type: "visit_late", label: "A tech running late for a stop" },
  { type: "route_finished", label: "A tech finished their route" },
  // Auto-routing that ran in the background (src/lib/auto-routing.server.ts),
  // to the person who pressed Apply, and only when they had left the page.
  { type: "routing_ready", label: "Auto-routing finished in the background" },
  { type: "routing_failed", label: "Auto-routing did not finish" },
  // A sitter logged a medication as missed (src/lib/sit-notify.server.ts), to
  // the owner, office managers and dispatchers.
  { type: "missed_meds", label: "A sitter missed a medication" },
  // Training (src/lib/training-portal.server.ts), to owners and office
  // managers: a package with one session left, or 14 days from expiry.
  { type: "training_package", label: "Training packages running low or expiring" },
];

/** A type only a business running this line can ever be sent. Settings
 *  lists it only to such a business, so a pet-waste business is not offered
 *  a switch for a sitter's missed medication (#411). Kept beside the list
 *  rather than in it: tests/en-and-es-have-the-same-keys.test.ts reads the
 *  entries above by their exact shape. A muted type stays muted either way. */
export const NOTIFICATION_TYPE_LINE: Partial<Record<string, ServiceLine>> = {
  missed_meds: "pet_sitting",
};

/** The types Settings offers a business that runs `lines`. */
export function notificationTypesFor(
  lines: readonly ServiceLine[],
): Array<{ type: string; label: string }> {
  return NOTIFICATION_TYPES.filter((t) => {
    const line = NOTIFICATION_TYPE_LINE[t.type];
    return !line || lines.includes(line);
  });
}

export const getNotificationPrefs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await (context.supabase as any)
      .from("app_notification_prefs")
      .select("muted_types")
      .eq("user_id", context.userId)
      .maybeSingle();
    // The caller's business; an answer that cannot be read is pet waste
    // (serviceLinesOrDefault), the rule every menu uses.
    let lines: unknown = null;
    try {
      const { resolveCaller } = await import("@/lib/authz.server");
      const { orgId } = await resolveCaller(context.supabase, context.userId);
      const { data: org } = await context.supabase
        .from("organizations")
        .select("service_lines")
        .eq("id", orgId)
        .maybeSingle();
      lines = org?.service_lines;
    } catch {
      lines = null;
    }
    return {
      mutedTypes: (data?.muted_types as string[]) ?? [],
      types: notificationTypesFor(serviceLinesOrDefault(lines)),
    };
  });

export const setNotificationPrefs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ mutedTypes: z.array(z.string().max(64)).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    const allowed = new Set(NOTIFICATION_TYPES.map((t) => t.type));
    const muted = data.mutedTypes.filter((t) => allowed.has(t));
    const { error } = await (context.supabase as any)
      .from("app_notification_prefs")
      .upsert(
        { user_id: context.userId, muted_types: muted, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** The language this person reads, so a push about their own route is
 *  written in it. The interface language lives in the phone's localStorage
 *  (lib/i18n), where the server that writes a push cannot see it; the app
 *  calls this when it starts and when the language changes
 *  (useNotificationLanguageSync). Only the language column is written, so
 *  the person's mutes are untouched. */
export const setMyNotificationLanguage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ language: z.enum(["en", "es", "ar", "zh"]) }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await (context.supabase as any)
      .from("app_notification_prefs")
      .upsert({ user_id: context.userId, language: data.language }, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
