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

// ─── FCM (Android) via the HTTP v1 API ─────────────────────────────────────
//
// This used to post to `https://fcm.googleapis.com/fcm/send` with an
// `Authorization: key=…` server key. That is the legacy API, and Google
// decommissioned it — the endpoint does not accept sends any more, so every
// Android notification this app has ever tried has failed. The comment above
// it said to migrate "if Google fully sunsets", which they did.
//
// v1 differs in three ways that matter, and only the first is obvious:
//
//   The auth is an OAuth2 access token, not a static key. It is minted by
//   signing a JWT with the service account's private key and exchanging it at
//   Google's token endpoint. Tokens last an hour, so they are cached — a fan-out
//   to fifty devices must not do fifty token exchanges.
//
//   `data` values must all be strings. Legacy accepted arbitrary JSON and
//   `PushPayload.data` is a `Record<string, unknown>`, so a caller passing a
//   number or an object would now get INVALID_ARGUMENT for the whole send.
//   Coerced rather than trusted; see `fcmDataStrings`.
//
//   `click_action`, `icon` and `tag` moved under `android.notification` and
//   were renamed. `tag` is what collapses repeated notifications on the device,
//   so silently dropping it would give a tech twelve identical rows.
//
// Configured with FCM_SERVICE_ACCOUNT: the JSON Firebase hands you at Project
// settings → Service accounts → Generate new private key, pasted whole. One
// variable rather than three, because that is the shape it arrives in and
// splitting it invites a private key mangled by a shell.

type FcmCredentials = { projectId: string; clientEmail: string; privateKey: string };

/** Parse the service-account JSON. Returns null — never throws — so an absent
 *  or malformed credential leaves Android push unconfigured in the same way
 *  every other channel here does, rather than taking a notification fan-out
 *  down with it. */
export function parseFcmCredentials(raw: string | undefined): FcmCredentials | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    const projectId = j.project_id;
    const clientEmail = j.client_email;
    // A key pasted through an environment variable usually arrives with its
    // newlines escaped. Google's own libraries do this same replacement.
    const privateKey = typeof j.private_key === "string" ? j.private_key.replace(/\\n/g, "\n") : null;
    if (!projectId || !clientEmail || !privateKey) return null;
    return { projectId, clientEmail, privateKey };
  } catch {
    return null;
  }
}

/** FCM v1 rejects a message whose `data` holds anything but strings, and the
 *  rejection is for the whole send rather than the offending key. Numbers and
 *  booleans stringify; objects and arrays go through JSON so the receiver can
 *  parse them back; null and undefined are dropped rather than becoming the
 *  strings "null" and "undefined" on the device. */
export function fcmDataStrings(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** The v1 message body for one device. Pure, so the shape is testable without
 *  a credential or a network. */
export type FcmMessage = {
  message: {
    token: string;
    notification: { title: string; body: string };
    android: { notification: Record<string, string> };
    data: Record<string, string>;
  };
};

export function fcmMessageFor(token: string, payload: PushPayload): FcmMessage {
  return {
    message: {
      token,
      notification: { title: payload.title, body: payload.body ?? "" },
      android: {
        notification: {
          // Renamed in v1: tag collapses repeats on the device, click_action
          // names the intent filter the tap opens.
          ...(payload.tag ? { tag: payload.tag } : {}),
          ...(payload.icon ? { icon: payload.icon } : {}),
          ...(payload.url ? { click_action: "FCM_PLUGIN_ACTIVITY" } : {}),
        },
      },
      // The URL rides in data as well as in click_action: the Capacitor plugin
      // hands `data` to the app on tap, and that is what routes it.
      data: { url: payload.url ?? "", ...fcmDataStrings(payload.data) },
    },
  };
}

/** An access token good for an hour, cached until a minute before it expires
 *  so a fan-out does one exchange rather than one per device. */
let fcmToken: { value: string; expiresAt: number } | null = null;

async function fcmAccessToken(creds: FcmCredentials): Promise<string | null> {
  if (fcmToken && Date.now() < fcmToken.expiresAt) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput =
    `${b64({ alg: "RS256", typ: "JWT" })}.` +
    b64({
      iss: creds.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const crypto = await import("crypto");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput), creds.privateKey);
  const assertion = `${signingInput}.${sig.toString("base64url")}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.access_token) {
    // Logged rather than thrown: a broken credential must not stop the web and
    // iOS halves of the same fan-out from going out.
    console.error("fcm token exchange failed", res.status, json?.error_description ?? json?.error);
    return null;
  }
  const ttl = Number(json.expires_in ?? 3600);
  fcmToken = { value: json.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 };
  return fcmToken.value;
}

/** v1 reports a dead token as UNREGISTERED (404) or as INVALID_ARGUMENT (400)
 *  when the token is malformed. Both mean stop sending to this row; every other
 *  error is transient and the row stays enabled. */
export function fcmErrorIsGone(status: number, body: unknown): boolean {
  const b = body as { error?: { status?: string; details?: Array<{ errorCode?: string }> } };
  if (status === 404) return true;
  const code = b?.error?.details?.find((d) => d?.errorCode)?.errorCode;
  if (code === "UNREGISTERED" || code === "INVALID_ARGUMENT") return true;
  return b?.error?.status === "NOT_FOUND";
}

async function sendFcm(subs: NativeSub[], payload: PushPayload) {
  const creds = parseFcmCredentials(process.env.FCM_SERVICE_ACCOUNT);
  if (!creds || subs.length === 0) return { sent: 0, failed: 0 };
  const accessToken = await fcmAccessToken(creds);
  if (!accessToken) return { sent: 0, failed: subs.length };
  const url = `https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`;
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(fcmMessageFor(s.native_token, payload)),
      });
      if (res.ok) {
        sent++;
        await markSent(s.id);
        return;
      }
      const json: any = await res.json().catch(() => ({}));
      const err =
        json?.error?.details?.find((d: any) => d?.errorCode)?.errorCode ??
        json?.error?.status ??
        `fcm_${res.status}`;
      await markError(s.id, err, fcmErrorIsGone(res.status, json));
      failed++;
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
