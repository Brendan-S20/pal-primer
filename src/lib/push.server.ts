// Server-only helpers for sending Web Push notifications.
import webpush from "web-push";

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:notify@thenorth.consulting";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  icon?: string;
  requireInteraction?: boolean;
  data?: Record<string, unknown>;
}

interface StoredSub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function sendToSubs(subs: StoredSub[], payload: PushPayload) {
  if (!ensureConfigured() || subs.length === 0) return { sent: 0, failed: 0 };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
        sent++;
        await supabaseAdmin
          .from("push_subscriptions")
          .update({ last_sent_at: new Date().toISOString(), last_error: null })
          .eq("id", s.id);
      } catch (err: any) {
        failed++;
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          await supabaseAdmin
            .from("push_subscriptions")
            .update({ disabled: true, last_error: `gone:${status}` })
            .eq("id", s.id);
        } else {
          await supabaseAdmin
            .from("push_subscriptions")
            .update({ last_error: String(err?.message || err).slice(0, 500) })
            .eq("id", s.id);
        }
      }
    }),
  );
  return { sent, failed };
}

export async function sendPushToUser(userId: string, payload: PushPayload) {
  if (!ensureConfigured()) return { sent: 0, failed: 0, skipped: true as const };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId)
    .eq("disabled", false);
  return sendToSubs((data ?? []) as StoredSub[], payload);
}

export async function sendPushToClient(clientId: string, payload: PushPayload) {
  if (!ensureConfigured()) return { sent: 0, failed: 0, skipped: true as const };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("client_id", clientId)
    .eq("disabled", false);
  return sendToSubs((data ?? []) as StoredSub[], payload);
}
