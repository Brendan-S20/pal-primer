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

// ─── APNs (iOS) ────────────────────────────────────────────────────────────
//
// Token-based auth: an ES256 JWT signed with the .p8 key from Apple Developer
// → Keys, posted to /3/device/<token>. Configured with five variables, read
// from the app server's runtime secrets (Lovable project secrets — the same
// store as every other `process.env` read in this file; see OPS_RUNBOOK.md §1):
//
//   APNS_TEAM_ID      10-char Apple team ID (Membership details)
//   APNS_KEY_ID       10-char ID of the key, shown beside it in Keys
//   APNS_AUTH_KEY     the .p8 file's contents, BEGIN/END lines included
//   APNS_TOPIC        the bundle id. Optional: defaults to APNS_DEFAULT_TOPIC,
//                     which a test pins to capacitor.config.ts's appId
//   APNS_ENVIRONMENT  "production" (default) or "sandbox"/"development"
//
// Four things here are easy to get wrong without any error saying so:
//
//   * HTTP/2. APNs refuses HTTP/1.1. The production server is a Cloudflare
//     Worker (Nitro's cloudflare-module preset), whose fetch() reaches Apple
//     over HTTP/2 through Cloudflare's edge — that is the path this is written
//     for. Node's built-in fetch (undici) speaks HTTP/1.1 only, so a LOCAL
//     `npm run dev` cannot deliver to APNs whatever the credentials are; test
//     a real send on the deployed app.
//
//   * The JWT is cached. Apple rejects a provider token regenerated more often
//     than every 20 minutes (429 TooManyProviderTokenUpdates) and one older
//     than an hour (403 ExpiredProviderToken). One per send — what this used to
//     do — trips the first as soon as notifications are frequent. Fifty
//     minutes sits inside both limits.
//
//   * Signing is WebCrypto, not node:crypto. `crypto.subtle` ECDSA already
//     returns the raw r||s signature JWS wants, and it is the same API on a
//     Worker and in Node — so the code the tests run is the code that ships.
//
//   * The environment is a property of the BUILD, not the server. A TestFlight
//     or App Store install has a production token; an app run from Xcode on a
//     cable has a sandbox one. Send either to the other host and Apple answers
//     400 BadDeviceToken. Production builds come from Xcode Cloud, so the
//     default is production.

/** The bundle id. capacitor.config.ts's appId — a test keeps them equal. */
export const APNS_DEFAULT_TOPIC = "consulting.thenorth.houndstack";

export const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

export type ApnsConfig = {
  teamId: string;
  keyId: string;
  authKey: string;
  topic: string;
  host: string;
};

/** Read the APNs configuration. Never throws: an incomplete one is reported as
 *  the list of variables that are missing, so the caller can say which. */
export function apnsConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): { config: ApnsConfig | null; missing: string[] } {
  const teamId = env.APNS_TEAM_ID?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const authKey = env.APNS_AUTH_KEY?.trim();
  const missing = [
    !teamId && "APNS_TEAM_ID",
    !keyId && "APNS_KEY_ID",
    !authKey && "APNS_AUTH_KEY",
  ].filter((m): m is string => !!m);
  if (missing.length) return { config: null, missing };
  return {
    config: {
      teamId: teamId!,
      keyId: keyId!,
      authKey: authKey!,
      topic: env.APNS_TOPIC?.trim() || APNS_DEFAULT_TOPIC,
      host: apnsHost(env.APNS_ENVIRONMENT),
    },
    missing: [],
  };
}

/** "sandbox" and "development" are the same APNs environment under Apple's
 *  two names for it (the entitlement says development, the host says
 *  sandbox). Anything else, including unset, is production. */
export function apnsHost(environment: string | undefined): string {
  const e = (environment ?? "").trim().toLowerCase();
  return e === "sandbox" || e === "development" ? APNS_HOSTS.sandbox : APNS_HOSTS.production;
}

/** The request for one device, minus the authorization header. Pure, so the
 *  wire shape is testable without a key or a network. */
export function apnsRequestFor(
  token: string,
  payload: PushPayload,
  topic: string,
): { path: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const headers: Record<string, string> = {
    "apns-topic": topic,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "content-type": "application/json",
  };
  // collapse-id is APNs' equivalent of the web-push `tag` (a newer
  // notification replaces the older one). Apple caps it at 64 bytes and
  // rejects the whole send over it, so an over-long tag only groups.
  if (payload.tag && new TextEncoder().encode(payload.tag).length <= 64) {
    headers["apns-collapse-id"] = payload.tag;
  }
  return {
    path: `/3/device/${token}`,
    headers,
    body: {
      aps: {
        alert: { title: payload.title, body: payload.body ?? "" },
        sound: "default",
        ...(payload.tag ? { "thread-id": payload.tag } : {}),
      },
      // Top-level custom keys arrive in the tap handler as
      // `notification.data` — initPushDeepLinks in src/lib/native.ts reads
      // `data.url`, or `data.data.url` for a caller that nests it.
      ...(payload.url ? { url: payload.url } : {}),
      data: payload.data ?? {},
    },
  };
}

/** Stop sending to this row? 410 is Apple saying the token is no longer
 *  active (the app was deleted, or notifications revoked). 400 BadDeviceToken
 *  is a token from the other environment or a malformed one, and
 *  DeviceTokenNotForTopic is a token for some other app: neither will ever
 *  work against this server. Everything else — a bad key (403), a rate limit
 *  (429), Apple being down (5xx) — is about us, not the device, and must not
 *  switch a working phone off.
 *
 *  "Off" is `disabled = true` with the reason in last_error, the same as the
 *  web-push and FCM paths above, rather than a DELETE: every sender filters
 *  on disabled = false, a re-registration of the same token switches it back
 *  on, and "why did my phone stop buzzing" has an answer in the row. */
export function apnsErrorIsGone(status: number, reason: string | undefined): boolean {
  if (status === 410) return true;
  return reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic" || reason === "Unregistered";
}

/** The DER body of the .p8, however it was pasted: with real newlines, with
 *  `\n` escaped by an env-var UI, or flattened onto one line. */
export function p8ToDer(authKey: string): ArrayBuffer {
  const b64 = authKey
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END)[^-]*-----/g, "")
    .replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
    throw new Error("APNS_AUTH_KEY is not the contents of a .p8 file");
  }
  const bytes = Buffer.from(b64, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString(
    "base64url",
  );

let apnsJwtCache: { cacheKey: string; value: string; issuedAt: number } | null = null;
const APNS_JWT_TTL_MS = 50 * 60 * 1000;

/** Test hook: forget the cached provider token. */
export function resetApnsTokenCacheForTests() {
  apnsJwtCache = null;
}

/** The provider token, reused for fifty minutes. Throws on an unreadable key
 *  — the caller turns that into a log line, never into a failed request. */
export async function apnsProviderToken(config: ApnsConfig, now = Date.now()): Promise<string> {
  const cacheKey = `${config.teamId}:${config.keyId}:${config.authKey.length}`;
  if (
    apnsJwtCache &&
    apnsJwtCache.cacheKey === cacheKey &&
    now - apnsJwtCache.issuedAt < APNS_JWT_TTL_MS
  ) {
    return apnsJwtCache.value;
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    p8ToDer(config.authKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signingInput =
    `${b64url(JSON.stringify({ alg: "ES256", kid: config.keyId, typ: "JWT" }))}.` +
    b64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const value = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  apnsJwtCache = { cacheKey, value, issuedAt: now };
  return value;
}

let warnedApnsUnconfigured = false;

async function sendApns(subs: NativeSub[], payload: PushPayload) {
  if (subs.length === 0) return { sent: 0, failed: 0 };
  const { config, missing } = apnsConfigFromEnv();
  if (!config) {
    // Said once per server instance, not once per send: an unconfigured key
    // is a setup fact, and a log line per notification would bury everything
    // else. The rows are left alone — nothing is wrong with the devices.
    if (!warnedApnsUnconfigured) {
      warnedApnsUnconfigured = true;
      console.warn(
        `[push] ${subs.length} iOS device(s) skipped: APNs is not configured (missing ${missing.join(", ")}). ` +
          "See docs/ios-build.md › Push notifications.",
      );
    }
    return { sent: 0, failed: 0 };
  }

  let jwt: string;
  try {
    jwt = await apnsProviderToken(config);
  } catch (e) {
    console.error("[push] APNs provider token could not be signed — check APNS_AUTH_KEY", e);
    return { sent: 0, failed: subs.length };
  }

  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const req = apnsRequestFor(s.native_token, payload, config.topic);
      const res = await fetch(`${config.host}${req.path}`, {
        method: "POST",
        headers: { authorization: `bearer ${jwt}`, ...req.headers },
        body: JSON.stringify(req.body),
      });
      if (res.status === 200) {
        sent++;
        await markSent(s.id);
        return;
      }
      const reason: string | undefined = (await res.json().catch(() => ({})))?.reason;
      // A rejected provider token is ours to fix, and a cached bad one would
      // keep failing for fifty minutes after the key is corrected.
      if (res.status === 403) apnsJwtCache = null;
      await markError(s.id, reason ?? `apns_${res.status}`, apnsErrorIsGone(res.status, reason));
      failed++;
    } catch (e: any) {
      failed++;
      await markError(s.id, String(e?.message || e)).catch(() => {});
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
  // allSettled, not all: one channel throwing must not take the other two
  // down with it, and must not reach the caller either.
  const results = await Promise.allSettled([
    sendWebPush(web, payload),
    sendApns(ios, payload),
    sendFcm(android, payload),
  ]);
  let sent = 0, failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      sent += r.value.sent;
      failed += r.value.failed;
    } else {
      console.error("[push] a delivery channel threw", r.reason);
    }
  }
  return { sent, failed };
}

const SELECT_COLS = "id, endpoint, p256dh, auth, native_token, platform";

/** Every enabled device a staff user has registered: web, iOS and Android.
 *  Never throws — push is always the best-effort half of something else. */
export async function sendPushToUser(userId: string, payload: PushPayload) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("push_subscriptions")
      .select(SELECT_COLS)
      .eq("user_id", userId)
      .eq("disabled", false);
    return await fanOut((data ?? []) as Row[], payload);
  } catch (e) {
    console.error("[push] sendPushToUser failed", e);
    return { sent: 0, failed: 0 };
  }
}

export async function sendPushToClient(clientId: string, payload: PushPayload) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("push_subscriptions")
      .select(SELECT_COLS)
      .eq("client_id", clientId)
      .eq("disabled", false);
    return await fanOut((data ?? []) as Row[], payload);
  } catch (e) {
    console.error("[push] sendPushToClient failed", e);
    return { sent: 0, failed: 0 };
  }
}

// ─── Saving a subscription ─────────────────────────────────────────────────
//
// This replaced `.upsert(row, { onConflict: "native_token" })` (and the same
// on "endpoint"), which could never succeed. Both columns are unique through
// PARTIAL indexes — `... WHERE native_token IS NOT NULL`, from migration
// 20260703040022 — and Postgres will not infer a partial index from a bare
// `ON CONFLICT (native_token)`; the statement needs the index's WHERE clause,
// which PostgREST has no way to send. Every call failed with
//   there is no unique or exclusion constraint matching the ON CONFLICT specification
// (reproduced against a scratch Postgres 18 with the same index), into a
// console.warn on the phone. So no iOS token was ever stored.
//
// It runs on the service role because a device token, or a browser's push
// endpoint, belongs to whoever is signed in on that device NOW. On a shared
// crew iPad the row may still name the previous tech; RLS hides that row from
// the new one, so an RLS-scoped write cannot move it and the previous tech
// would go on receiving the new tech's notifications. The caller has already
// authenticated the user (or the portal token) whose id goes on the row.

type PushKey = { column: "native_token"; value: string } | { column: "endpoint"; value: string };

type AdminLike = { from: (table: string) => any };

export async function savePushSubscription(
  admin: AdminLike,
  key: PushKey,
  row: Record<string, unknown>,
): Promise<void> {
  const fields = { ...row, disabled: false, last_error: null };
  const update = async () => {
    const { data, error } = await admin
      .from("push_subscriptions")
      .update(fields)
      .eq(key.column, key.value)
      .select("id");
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  };
  if (await update()) return;
  const { error } = await admin
    .from("push_subscriptions")
    .insert({ ...fields, [key.column]: key.value });
  if (!error) return;
  // Two registrations racing for the same token (two tabs, a quick relaunch):
  // the other one inserted between our update and our insert. Ours is now an
  // update of the row it made.
  if (error.code === "23505" && (await update())) return;
  throw new Error(error.message);
}
