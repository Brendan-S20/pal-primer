// Server-only helpers for sending push notifications.
// Handles three delivery channels:
//   • Web Push (VAPID) — browsers, PWAs
//   • Android FCM      — Capacitor android app
//   • iOS APNs (HTTP/2) — Capacitor ios app
//
// Each channel is opt-in via env vars. Missing keys ⇒ that channel is silently
// skipped so the app still works with just Web Push configured.
import webpush from "web-push";

let webConfigured = false;
function ensureWebConfigured() {
  if (webConfigured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:notify@thenorth.consulting";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  webConfigured = true;
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

interface WebSub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface NativeSub {
  id: string;
  native_token: string;
  platform: "ios" | "android";
}

async function markSent(id: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("push_subscriptions")
    .update({ last_sent_at: new Date().toISOString(), last_error: null })
    .eq("id", id);
}

async function markError(id: string, err: string, gone = false) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("push_subscriptions")
    .update({ last_error: err.slice(0, 500), disabled: gone || undefined })
    .eq("id", id);
}

async function sendWebPush(subs: WebSub[], payload: PushPayload) {
  if (!ensureWebConfigured() || subs.length === 0) return { sent: 0, failed: 0 };
  const body = JSON.stringify(payload);
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
      );
      sent++;
      await markSent(s.id);
    } catch (err: any) {
      failed++;
      const status = err?.statusCode;
      const gone = status === 404 || status === 410;
      await markError(s.id, gone ? `gone:${status}` : String(err?.message || err), gone);
    }
  }));
  return { sent, failed };
}

// ─── FCM (Android) via legacy HTTP API ─────────────────────────────────────
// Uses FCM_SERVER_KEY (Firebase Console → Cloud Messaging → "Server key").
// Not the newest HTTP v1 protocol, but works today and requires no OAuth
// dance. Migrate to HTTP v1 with a service-account JWT if Google fully sunsets.
async function sendFcm(subs: NativeSub[], payload: PushPayload) {
  const key = process.env.FCM_SERVER_KEY;
  if (!key || subs.length === 0) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const res = await fetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `key=${key}`,
        },
        body: JSON.stringify({
          to: s.native_token,
          notification: {
            title: payload.title,
            body: payload.body ?? "",
            icon: payload.icon,
            tag: payload.tag,
            click_action: payload.url,
          },
          data: { url: payload.url ?? "", ...(payload.data ?? {}) },
        }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || json?.failure) {
        const err = json?.results?.[0]?.error || `fcm_${res.status}`;
        const gone = err === "NotRegistered" || err === "InvalidRegistration";
        await markError(s.id, err, gone);
        failed++;
      } else {
        sent++;
        await markSent(s.id);
      }
    } catch (e: any) {
      failed++;
      await markError(s.id, String(e?.message || e));
    }
  }));
  return { sent, failed };
}

// ─── APNs (iOS) via HTTP/2 ─────────────────────────────────────────────────
// Requires:
//   APNS_TEAM_ID        — 10-char Apple team ID
//   APNS_KEY_ID         — 10-char key ID
//   APNS_AUTH_KEY       — raw .p8 file contents (PEM)
//   APNS_TOPIC          — bundle ID (e.g. consulting.thenorth.pal)
//   APNS_ENVIRONMENT    — "production" or "sandbox" (default production)
async function apnsToken(): Promise<string | null> {
  const team = process.env.APNS_TEAM_ID;
  const kid = process.env.APNS_KEY_ID;
  const pem = process.env.APNS_AUTH_KEY;
  if (!team || !kid || !pem) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid, typ: "JWT" };
  const claims = { iss: team, iat: now };
  const b64 = (o: any) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const crypto = await import("crypto");
  // Node's KeyObject accepts PKCS#8 EC private key PEM.
  const key = crypto.createPrivateKey({ key: pem, format: "pem" });
  const sig = crypto.sign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${sig.toString("base64url")}`;
}

async function sendApns(subs: NativeSub[], payload: PushPayload) {
  const topic = process.env.APNS_TOPIC;
  const jwt = await apnsToken();
  if (!topic || !jwt || subs.length === 0) return { sent: 0, failed: 0 };
  const host = process.env.APNS_ENVIRONMENT === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const res = await fetch(`${host}/3/device/${s.native_token}`, {
        method: "POST",
        headers: {
          "authorization": `bearer ${jwt}`,
          "apns-topic": topic,
          "apns-push-type": "alert",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          aps: {
            alert: { title: payload.title, body: payload.body ?? "" },
            sound: "default",
            "thread-id": payload.tag,
          },
          url: payload.url,
          data: payload.data ?? {},
        }),
      });
      if (res.status === 200) {
        sent++;
        await markSent(s.id);
      } else {
        const reason = (await res.json().catch(() => ({}))).reason ?? `apns_${res.status}`;
        const gone = reason === "BadDeviceToken" || reason === "Unregistered";
        await markError(s.id, reason, gone);
        failed++;
      }
    } catch (e: any) {
      failed++;
      await markError(s.id, String(e?.message || e));
    }
  }));
  return { sent, failed };
}

// ─── Public fan-out helpers ────────────────────────────────────────────────

type Row = {
  id: string;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  native_token: string | null;
  platform: string | null;
};

function splitRows(rows: Row[]): { web: WebSub[]; ios: NativeSub[]; android: NativeSub[] } {
  const web: WebSub[] = [];
  const ios: NativeSub[] = [];
  const android: NativeSub[] = [];
  for (const r of rows) {
    if (r.native_token && r.platform === "ios") {
      ios.push({ id: r.id, native_token: r.native_token, platform: "ios" });
    } else if (r.native_token && r.platform === "android") {
      android.push({ id: r.id, native_token: r.native_token, platform: "android" });
    } else if (r.endpoint && r.p256dh && r.auth) {
      web.push({ id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth });
    }
  }
  return { web, ios, android };
}

async function fanOut(rows: Row[], payload: PushPayload) {
  const { web, ios, android } = splitRows(rows);
  const [w, i, a] = await Promise.all([
    sendWebPush(web, payload),
    sendApns(ios, payload),
    sendFcm(android, payload),
  ]);
  return { sent: w.sent + i.sent + a.sent, failed: w.failed + i.failed + a.failed };
}

const SELECT_COLS = "id, endpoint, p256dh, auth, native_token, platform";

export async function sendPushToUser(userId: string, payload: PushPayload) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("push_subscriptions")
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .eq("disabled", false);
  return fanOut((data ?? []) as Row[], payload);
}

export async function sendPushToClient(clientId: string, payload: PushPayload) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("push_subscriptions")
    .select(SELECT_COLS)
    .eq("client_id", clientId)
    .eq("disabled", false);
  return fanOut((data ?? []) as Row[], payload);
}
