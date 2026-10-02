// Server-only portal authentication: OTP issue/verify + short-lived session
// cookies. The {uuid} in the URL only identifies WHICH client's portal is
// being requested; unlocking it requires a one-time code sent to the contact
// on file, which mints a 30-day session. See QA finding #4.
//
// Import inside server-function handlers only (uses service_role + cookies).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// @tanstack/react-start/server is server-only and denied in the client bundle.
// portal.functions.ts (which ships to the client) statically imports this
// module, so we must not import that specifier at the top level — load the
// request/response helpers lazily inside the functions that need them.
async function reqres() {
  return import("@tanstack/react-start/server");
}

const COOKIE_PREFIX = "hs_portal_";
const SESSION_TTL_DAYS = 30;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5; // guesses per issued code
const OTP_MIN_INTERVAL_MS = 30_000; // between requests for one client
const OTP_MAX_PER_CLIENT_HOUR = 5;
const OTP_MAX_PER_IP_HOUR = 15;

/** Thrown when a staff preview tries to do something only the customer may.
 *  The message is what the owner sees in the toast. */
export class PortalPreviewIsReadOnly extends Error {
  code = "PORTAL_PREVIEW_READ_ONLY" as const;
  constructor() {
    super("This is a preview of the customer's portal, so nothing here can be changed.");
  }
}

/** How long a staff preview lasts. Long enough to look around, short enough
 *  that the owner's browser does not stay signed in as the customer. */
const PREVIEW_TTL_MINUTES = 60;

/** Thrown when a portal action is attempted without a valid session. */
export class PortalVerificationRequired extends Error {
  code = "PORTAL_VERIFICATION_REQUIRED" as const;
  constructor() {
    super("PORTAL_VERIFICATION_REQUIRED");
  }
}

async function sbAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function cookieName(token: string): string {
  // Scope the cookie to the specific client token so one device holding links
  // to two different clients keeps separate sessions.
  return COOKIE_PREFIX + sha256(token).slice(0, 16);
}

async function callerIp(): Promise<string | null> {
  try {
    const { getRequestIP } = await reqres();
    return getRequestIP({ xForwardedFor: true }) ?? null;
  } catch {
    return null;
  }
}

export type OrgBranding = {
  org_name: string;
  org_slug: string | null;
  logo_url: string | null;
  brand_color: string | null;
  // The org's IANA timezone rides with the branding because it answers the
  // same question the logo does: WHOSE portal is this? Every visit instant the
  // portal prints — ETA windows, completion times, the change cutoff — must
  // read on this clock, and the portal has no staff session and no ["my-org"]
  // query to fetch it from, so the one lookup that already reaches every
  // portal page (this one) carries it. See org-day.ts for the rendering side.
  org_timezone: string | null;
};

type ContactRow = OrgBranding & {
  client_id: string;
  organization_id: string;
  display_name: string;
  primary_phone: string | null;
  primary_email: string | null;
};

// Resolve a client by its portal token directly via the service-role client
// (bypasses RLS), returning contact + org branding + slug in one query. This
// replaces the old portal_resolve_contact RPC so branding lives in code.
async function resolveContact(token: string): Promise<ContactRow | null> {
  const supabaseAdmin = await sbAdmin();
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select(
      "id, organization_id, display_name, primary_phone, primary_email, active, organizations(name, portal_slug, logo_url, brand_color, timezone)",
    )
    .eq("portal_token", token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !data.active) return null;
  const org: any = Array.isArray(data.organizations) ? data.organizations[0] : data.organizations;
  return {
    client_id: data.id,
    organization_id: data.organization_id,
    display_name: data.display_name,
    primary_phone: data.primary_phone,
    primary_email: data.primary_email,
    org_name: org?.name ?? "Your service",
    org_slug: org?.portal_slug ?? null,
    logo_url: org?.logo_url ?? null,
    brand_color: org?.brand_color ?? null,
    org_timezone: org?.timezone ?? null,
  };
}

function maskPhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• •••• ${digits.slice(-4)}` : "your phone";
}
function maskEmail(e: string): string {
  // Reduce leakage (G2): reveal only the FIRST character of the local part and
  // the top-level domain — never the full local part or the provider/domain
  // (e.g. "jane.doe@gmail.com" → "j•••@•••.com"). Enough for the client to
  // recognize "yes, that's my email" without disclosing it to a shoulder-surfer.
  const [user, domain] = e.split("@");
  if (!domain) return "your email";
  const head = user.slice(0, 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot >= 0 ? domain.slice(dot) : "";
  return `${head}${"•".repeat(Math.max(2, user.length - 1))}@•••${tld}`;
}

export type PortalChannel = "sms" | "email";

export type PortalBranding = {
  orgName: string;
  orgSlug: string | null;
  logoUrl: string | null;
  brandColor: string | null;
  /** IANA zone the org's clocks read in. Null only if the column is somehow
   *  unset; readers fall back to DEFAULT_ORG_TIMEZONE, never to the device. */
  timezone: string | null;
};

export type PortalContact = {
  clientId: string;
  organizationId: string;
  branding: PortalBranding;
  channels: Array<{ channel: PortalChannel; hint: string }>;
};

function brandingOf(c: OrgBranding): PortalBranding {
  return {
    orgName: c.org_name,
    orgSlug: c.org_slug,
    logoUrl: c.logo_url,
    brandColor: c.brand_color,
    timezone: c.org_timezone,
  };
}

/** True when the platform can actually deliver an SMS OTP. Offering "Text me
 *  a code" (and pre-selecting it) while Twilio is unconfigured shows the
 *  customer a raw config error on the default login path (P0.5). */
async function smsOtpDeliverable(orgId: string): Promise<boolean> {
  if (!process.env.TWILIO_API_KEY) return false;
  const { platformTwilioFrom } = await import("@/lib/twilio-credentials.server");
  if (platformTwilioFrom()) return true;
  const supabaseAdmin = await sbAdmin();
  const { data } = await supabaseAdmin
    .from("organizations")
    .select("sms_from_number")
    .eq("id", orgId)
    .maybeSingle();
  return !!data?.sms_from_number;
}

/** Channels we can send an OTP to, with masked hints + org branding for the UI. */
export async function portalContactChannels(token: string): Promise<PortalContact | null> {
  const c = await resolveContact(token);
  if (!c) return null;
  const channels: PortalContact["channels"] = [];
  if (c.primary_phone && (await smsOtpDeliverable(c.organization_id))) {
    channels.push({ channel: "sms", hint: maskPhone(c.primary_phone) });
  }
  if (c.primary_email) channels.push({ channel: "email", hint: maskEmail(c.primary_email) });
  return {
    clientId: c.client_id,
    organizationId: c.organization_id,
    branding: brandingOf(c),
    channels,
  };
}

/** Org branding + slug for the generic company sign-in page, looked up by slug. */
export async function orgBrandingBySlug(
  slug: string,
): Promise<(PortalBranding & { organizationId: string }) | null> {
  const supabaseAdmin = await sbAdmin();
  const { data } = await supabaseAdmin
    .from("organizations")
    .select("id, name, portal_slug, logo_url, brand_color, timezone")
    .eq("portal_slug", slug)
    .maybeSingle();
  if (!data) return null;
  return {
    organizationId: data.id,
    orgName: data.name ?? "Your service",
    orgSlug: data.portal_slug ?? null,
    logoUrl: data.logo_url ?? null,
    brandColor: data.brand_color ?? null,
    timezone: data.timezone ?? null,
  };
}

/** Resolve the org slug for a legacy bare token, so /portal/{uuid} can redirect. */
export async function slugForToken(token: string): Promise<string | null> {
  const c = await resolveContact(token);
  if (!c) return null;
  if (c.org_slug) return c.org_slug;
  // Backfill covers existing orgs; generate on the fly for any that slipped through.
  const { ensureOrgSlug } = await import("@/lib/portal-links.server");
  return ensureOrgSlug(c.organization_id);
}

/**
 * Return the active session's client_id for this token, or null if the caller
 * must verify. Also refreshes last_seen_at. A session is only valid for the
 * client the token currently points to — rotating the token (Regenerate)
 * orphans every old session.
 */
export type PortalSession = {
  clientId: string;
  organizationId: string;
  /** True for a staff preview, which may read but never act. */
  preview: boolean;
};

export async function getPortalSession(token: string): Promise<PortalSession | null> {
  const { getCookie } = await reqres();
  const raw = getCookie(cookieName(token));
  if (!raw) return null;
  const supabaseAdmin = await sbAdmin();
  const contact = await resolveContact(token);
  if (!contact) return null; // token rotated or client deactivated

  const { data: sess } = await supabaseAdmin
    .from("portal_sessions")
    .select("id, client_id, organization_id, expires_at, revoked_at, preview_by")
    .eq("token_hash", sha256(raw))
    .maybeSingle();
  if (!sess) return null;
  if (sess.client_id !== contact.client_id) return null; // token points elsewhere now
  if (sess.revoked_at) return null;
  if (new Date(sess.expires_at).getTime() < Date.now()) return null;

  await supabaseAdmin
    .from("portal_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", sess.id);
  return {
    clientId: sess.client_id,
    organizationId: sess.organization_id,
    preview: sess.preview_by != null,
  };
}

/**
 * Throws PortalVerificationRequired unless a valid session exists, and
 * PortalPreviewIsReadOnly if it is a staff preview and the caller did not
 * say it only reads.
 *
 * The default is refusal on purpose. A portal action written tomorrow that
 * forgets the option is read-only in a preview, which is a bug somebody
 * notices; the other default would let an owner's look around the portal
 * skip a visit or charge a card, which is a bug nobody notices.
 * tests/an-owner-could-not-see-the-portal.test.ts checks that only reads
 * pass `readOnly: true`.
 */
export async function requirePortalSession(
  token: string,
  opts: { readOnly?: boolean } = {},
): Promise<PortalSession> {
  const s = await getPortalSession(token);
  if (!s) throw new PortalVerificationRequired();
  if (s.preview && !opts.readOnly) throw new PortalPreviewIsReadOnly();
  return s;
}

function genOtp(): string {
  // 6 digits, uniform, from a CSPRNG.
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/**
 * Issue and deliver an OTP. Rate-limited per client and per IP. Returns the
 * masked destination hint; never returns the code (except to the owner-side
 * read-code action, which reads portal_otps directly via a different path).
 */
export async function issuePortalOtp(
  token: string,
  channel: PortalChannel,
): Promise<{ sent: boolean; hint: string; channel: PortalChannel }> {
  const supabaseAdmin = await sbAdmin();
  const contact = await resolveContact(token);
  if (!contact) throw new Error("Invalid portal link");

  const dest = channel === "sms" ? contact.primary_phone : contact.primary_email;
  if (!dest)
    throw new Error(`No ${channel === "sms" ? "phone" : "email"} on file for this account`);
  const hint = channel === "sms" ? maskPhone(dest) : maskEmail(dest);
  const ip = await callerIp();
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const nowIso = new Date().toISOString();

  // Expired, unused codes are not deliverable anymore. Remove them before
  // applying the per-client limiter so old failed/unusable sends cannot keep a
  // customer locked out for the rest of the hour.
  await supabaseAdmin
    .from("portal_otps")
    .delete()
    .eq("client_id", contact.client_id)
    .is("consumed_at", null)
    .lt("expires_at", nowIso)
    .then(
      () => {},
      () => {},
    );

  // Rate limits.
  const { data: recent } = await supabaseAdmin
    .from("portal_otps")
    .select("created_at")
    .eq("client_id", contact.client_id)
    .is("consumed_at", null)
    .gte("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(OTP_MAX_PER_CLIENT_HOUR);
  const recentRows = recent ?? [];
  if (
    recentRows[0] &&
    Date.now() - new Date(recentRows[0].created_at).getTime() < OTP_MIN_INTERVAL_MS
  ) {
    throw new Error("Please wait a moment before requesting another code.");
  }
  if (
    recentRows.filter((r: { created_at: string }) => r.created_at >= hourAgo).length >=
    OTP_MAX_PER_CLIENT_HOUR
  ) {
    throw new Error("Too many code requests. Try again later or contact us.");
  }
  if (ip) {
    const { count } = await supabaseAdmin
      .from("portal_otps")
      .select("id", { count: "exact", head: true })
      .eq("request_ip", ip)
      .gte("created_at", hourAgo);
    if ((count ?? 0) >= OTP_MAX_PER_IP_HOUR) {
      throw new Error("Too many code requests from this network. Try again later.");
    }
  }

  const code = genOtp();
  const { data: otpRow, error: otpInsertError } = await supabaseAdmin
    .from("portal_otps")
    .insert({
      client_id: contact.client_id,
      code_hash: sha256(code),
      channel,
      destination_hint: hint,
      expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
      request_ip: ip,
    })
    .select("id")
    .single();
  if (otpInsertError) throw new Error(otpInsertError.message);
  const otpRowId = (otpRow as { id?: string } | null)?.id ?? null;
  const rollbackOtp = async () => {
    if (!otpRowId) return;
    await supabaseAdmin
      .from("portal_otps")
      .delete()
      .eq("id", otpRowId)
      .then(
        () => {},
        () => {},
      );
  };

  const message = `${contact.org_name}: your verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`;
  try {
    if (channel === "sms") {
      const { data: org } = await supabaseAdmin
        .from("organizations")
        .select("sms_from_number")
        .eq("id", contact.organization_id)
        .single();
      // OTP is an auth flow — always sent from the PLATFORM's Twilio (reliable,
      // A2P-registered), never the tenant's BYOK number. Prefer the platform
      // sender number; fall back to the org's legacy number only if unset.
      const { platformTwilioFrom } = await import("@/lib/twilio-credentials.server");
      const otpFrom = platformTwilioFrom() ?? org?.sms_from_number ?? null;
      if (!otpFrom) throw new Error("SMS is not configured. Ask us to read you the code.");
      const { sendTwilioSms } = await import("@/lib/twilio.server");
      await sendTwilioSms({ from: otpFrom, to: dest, body: message });
    } else {
      // Send OTP email DIRECTLY (synchronous) via Resend, and LOG the
      // provider's response to email_send_log so every send is provable
      // (cross-reference the provider_message_id in the Resend dashboard). No
      // silent queue fallback — a failure is logged AND surfaced, never masked.
      const resendApiKey = process.env.RESEND_API_KEY;
      if (!resendApiKey)
        throw new Error("Email isn't configured for this company. Ask us to read you the code.");
      const logMessageId = `portal-otp-${randomBytes(8).toString("hex")}`;
      // NO List-Unsubscribe on this one. It used to mint a token and set
      // `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click`, exactly as the
      // marketing and notification sends do -- and /unsubscribe writes the
      // address into `suppressed_emails` GLOBALLY, which both senders fail
      // closed on. So a customer who tapped "unsubscribe" on a LOGIN CODE, or
      // whose mail client fired the one-click POST on their behalf while
      // scanning the message, silently stopped receiving their invoices, their
      // receipts and their visit notifications. Neither they nor the office
      // would be told, and the code itself kept working, because this send
      // POSTs Resend directly and never checks suppression -- so nothing about
      // the failure was visible from either end.
      //
      // RFC 8058 one-click exists for BULK mail. A one-time authentication
      // code is transactional: there is nothing to opt out of, and offering it
      // is how a login screen quietly turns off somebody's billing email.
      const emailBody = {
        from: `${contact.org_name} <noreply@notify.houndstack.com>`,
        to: [dest],
        subject: `Your ${contact.org_name} verification code`,
        html: `<p>Your verification code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p><p>It expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this, ignore this email.</p>`,
        text: message,
      };
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": logMessageId,
          },
          body: JSON.stringify(emailBody),
        });
        const bodyText = await res.text();
        if (!res.ok) throw new Error(`Resend ${res.status}: ${bodyText.slice(0, 300)}`);
        let providerId: string | null = null;
        try {
          providerId = JSON.parse(bodyText)?.id ?? null;
        } catch {
          /* noop */
        }
        await supabaseAdmin.from("email_send_log").insert({
          message_id: logMessageId,
          template_name: "portal-otp",
          recipient_email: dest,
          status: "sent",
          metadata: { provider: "resend", provider_message_id: providerId },
        });
      } catch (sendErr) {
        const msg = (sendErr as Error).message ?? "send failed";
        await supabaseAdmin
          .from("email_send_log")
          .insert({
            message_id: logMessageId,
            template_name: "portal-otp",
            recipient_email: dest,
            status: "failed",
            error_message: msg.slice(0, 500),
          })
          .then(
            () => {},
            () => {},
          );
        console.error("portal OTP email send failed", msg);
        throw new Error(
          "We couldn't email your code right now. Try SMS, or ask us to read it to you.",
        );
      }
    }
  } catch (e) {
    // Delivery failed — remove the pending OTP so it doesn't count against
    // the client's hourly rate limit and lock them out of retrying.
    await rollbackOtp();
    console.error("portal OTP delivery failed", (e as Error).message);
    const raw = (e as Error).message ?? "";
    // Never surface provider/config internals (e.g. "TWILIO_API_KEY is not
    // configured") to a customer on the login page.
    const friendly =
      channel === "sms" && /twilio|api.?key|not configured/i.test(raw)
        ? "Texting isn't available right now. Choose “Email me a code” instead, or ask us to read you the code."
        : raw || "Could not send the code. Ask us to read it to you instead.";
    throw new Error(friendly);
  }

  return { sent: true, hint, channel };
}

/**
 * Mint a single-use code for the office to read aloud to a client who can't
 * receive SMS/email. Returns the plaintext code (this path is owner-gated in
 * the calling server function; the code is never sent anywhere automatically).
 */
export async function issueOfficeReadCode(
  clientId: string,
): Promise<{ code: string; hint: string }> {
  const supabaseAdmin = await sbAdmin();
  const code = genOtp();
  await supabaseAdmin.from("portal_otps").insert({
    client_id: clientId,
    code_hash: sha256(code),
    channel: "sms",
    destination_hint: "read by office",
    expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
    request_ip: null,
  });
  return { code, hint: "read by office" };
}

/**
 * Verify a submitted code. On success, mints a session and sets the cookie.
 * Codes are single-use and attempt-limited.
 */
export async function verifyPortalOtp(token: string, code: string): Promise<boolean> {
  const contact = await resolveContact(token);
  if (!contact) throw new Error("Invalid portal link");
  // ONE shared OTP check for every flow (deep link, generic identify,
  // multi-match), then ONE shared session mint. No parallel implementations.
  await consumeOtpForClient(contact.client_id, code);
  await createPortalSession(token, contact.client_id, contact.organization_id);
  return true;
}

/**
 * Mint a session for a client's portal token and set the session cookie.
 * Shared by token-verify (verifyPortalOtp) and the generic-entry flow.
 *
 * path MUST be "/" — the session is read by TanStack server functions served
 * from /_serverFn/*, NOT under /portal. A path="/portal" cookie is never sent
 * to those requests, so verification would appear to fail even though it
 * succeeded. This was the finding-#4 verify incident.
 */
async function createPortalSession(
  token: string,
  clientId: string,
  orgId: string,
  previewBy: string | null = null,
): Promise<void> {
  const supabaseAdmin = await sbAdmin();
  const { setCookie, getRequestHeader } = await reqres();
  const secret = randomBytes(32).toString("hex");
  const ttlSeconds = previewBy ? PREVIEW_TTL_MINUTES * 60 : SESSION_TTL_DAYS * 86_400;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const { error } = await supabaseAdmin.from("portal_sessions").insert({
    client_id: clientId,
    organization_id: orgId,
    token_hash: sha256(secret),
    preview_by: previewBy,
    expires_at: expiresAt.toISOString(),
    ip: await callerIp(),
    user_agent: (() => {
      try {
        return getRequestHeader("user-agent") ?? null;
      } catch {
        return null;
      }
    })(),
  });
  // A cookie for a row that was never written is a sign-in that silently
  // does not work; say so instead.
  if (error) throw new Error(`Could not start the portal session: ${error.message}`);
  setCookie(cookieName(token), secret, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ttlSeconds,
  });
}

/**
 * A staff member's read-only look at a client's portal: a session on THIS
 * browser, marked with who opened it, that lasts an hour and that
 * requirePortalSession refuses for anything but reads. The caller has
 * already checked the permission and that the client is in the caller's
 * organization.
 */
export async function startPortalPreview(clientId: string, staffUserId: string): Promise<void> {
  const supabaseAdmin = await sbAdmin();
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("portal_token, organization_id, active")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.portal_token) throw new Error("This client has no portal link yet.");
  if (!data.active) throw new Error("An inactive client's portal is switched off.");
  await createPortalSession(data.portal_token, clientId, data.organization_id, staffUserId);
}

// ── Generic company sign-in (/portal/{slug}): identify → OTP → verify ────────
// Reuses the OTP/session primitives above. All lookups are scoped to a single
// organization — never a cross-org search (which would leak which companies a
// contact is a customer of).

const PICK_COOKIE = "hs_portal_pick";

function normalizeContact(raw: string): { kind: PortalChannel; value: string } | null {
  const t = raw.trim();
  if (t.includes("@")) return { kind: "email", value: t.toLowerCase() };
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 7) return { kind: "sms", value: digits };
  return null;
}

/** Canonical form used for matching + proof hashing (phone → last 10 digits). */
function canonicalContact(c: { kind: PortalChannel; value: string }): string {
  return c.kind === "email" ? c.value : c.value.replace(/\D/g, "").slice(-10);
}

type Match = {
  client_id: string;
  token: string;
  display_name: string;
  primary_phone: string | null;
  primary_email: string | null;
  street: string | null;
};

/** Active clients in ONE org whose phone or email matches the entered contact. */
async function matchClients(
  orgId: string,
  c: { kind: PortalChannel; value: string },
): Promise<Match[]> {
  const supabaseAdmin = await sbAdmin();
  let q = supabaseAdmin
    .from("clients")
    .select(
      "id, portal_token, display_name, primary_phone, primary_email, active, properties(street)",
    )
    .eq("organization_id", orgId)
    .eq("active", true);
  if (c.kind === "email") {
    q = q.ilike("primary_email", c.value);
  } else {
    // Compare on trailing digits to tolerate formatting differences.
    q = q.not("primary_phone", "is", null);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as any[];
  const filtered =
    c.kind === "email"
      ? rows
      : rows.filter((r) => (r.primary_phone ?? "").replace(/\D/g, "").endsWith(c.value.slice(-10)));
  return filtered.map((r) => ({
    client_id: r.id,
    token: r.portal_token,
    display_name: r.display_name,
    primary_phone: r.primary_phone,
    primary_email: r.primary_email,
    street: Array.isArray(r.properties)
      ? (r.properties[0]?.street ?? null)
      : (r.properties?.street ?? null),
  }));
}

function maskName(name: string): string {
  const first = (name || "").trim().split(/\s+/)[0] ?? "";
  return first ? `${first[0]}${"•".repeat(Math.max(1, first.length - 1))}` : "Account";
}
function maskStreet(street: string | null): string {
  if (!street) return "";
  const m = /^(\d+)\s+(.*)$/.exec(street.trim());
  if (!m) return "•••";
  const rest = m[2];
  return `${m[1]} ${rest.slice(0, 2)}${"•".repeat(Math.max(1, rest.length - 2))}`;
}

/**
 * Generic entry: find matching clients in the org, issue an OTP to the entered
 * contact, and return a masked hint + how many accounts matched. Throws if no
 * account matches. Does NOT reveal names or tokens.
 */
export async function portalIdentify(
  slug: string,
  contactRaw: string,
): Promise<{ sent: true; channel: PortalChannel; hint: string; matchCount: number }> {
  const org = await orgBrandingBySlug(slug);
  if (!org) throw new Error("We couldn't find that company.");
  const c = normalizeContact(contactRaw);
  if (!c) throw new Error("Enter a valid phone number or email.");
  const matches = await matchClients(org.organizationId, c);
  if (matches.length === 0) {
    throw new Error(
      "We couldn't find an account with that contact. Double-check it, or contact us.",
    );
  }
  // Issue the OTP against the first match; all matches share the entered contact
  // so the code reaches the same phone/email. issuePortalOtp handles rate limits.
  const res = await issuePortalOtp(matches[0].token, c.kind);
  return { sent: true, channel: res.channel, hint: res.hint, matchCount: matches.length };
}

/**
 * The MAC key for the pick cookie — the ONLY proof `portalChooseClient`
 * requires that a contact was just verified by OTP.
 *
 * ── WHY THIS THROWS INSTEAD OF FALLING BACK ───────────────────────────────
 *
 * It read `SUPABASE_SERVICE_ROLE_KEY || STRIPE_SECRET_KEY || "portal-pick"`.
 * Three problems, in order of severity:
 *
 *  1. `"portal-pick"` is a LITERAL IN THIS REPOSITORY. Reaching it makes every
 *     pick cookie forgeable: the only other check compares an attacker-supplied
 *     `contactHash` against `sha256(last-10-phone-digits)` or
 *     `sha256(lowercased email)`, both of which anyone who knows a customer's
 *     phone or email can compute. That is a full portal session — invoices,
 *     addresses, service history — for a named client, with no OTP. And it
 *     would happen SILENTLY, because a default is not an error.
 *
 *  2. It read the wrong variable name. Every other module in this codebase
 *     reads `SERVICE_ROLE_KEY || SUPABASE_SERVICE_ROLE_KEY` — client.server.ts,
 *     cron-auth.server.ts, weather.functions.ts and all six email routes — and
 *     `.env.example` ships only `SERVICE_ROLE_KEY`. This was the one module
 *     that checked the second name first and the first name never, so under
 *     the documented configuration it skipped straight past the intended key.
 *
 *  3. Falling back to `STRIPE_SECRET_KEY` makes a payment credential do
 *     double duty as a MAC key, so rotating Stripe silently invalidates every
 *     in-flight pick cookie — and, worse, a Stripe rotation that also cleared
 *     the variable would drop through to (1).
 *
 * An auth primitive with no key must fail, loudly. A portal sign-in that errors
 * is a support ticket; one that accepts forged cookies is a breach nobody sees.
 */
function pickSecret(): string {
  const s = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) {
    throw new Error(
      "SERVICE_ROLE_KEY is not set, so the portal pick cookie cannot be signed. " +
        "Refusing rather than falling back to a shared or default key.",
    );
  }
  return s;
}
function signPick(orgId: string, contactValue: string, expMs: number): string {
  const body = `${orgId}.${sha256(contactValue)}.${expMs}`;
  const mac = createHash("sha256").update(`${pickSecret()}.${body}`).digest("hex").slice(0, 32);
  return `${body}.${mac}`;
}
function verifyPick(raw: string | undefined): { orgId: string; contactHash: string } | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [orgId, contactHash, expStr, mac] = parts;
  const expected = createHash("sha256")
    .update(`${pickSecret()}.${orgId}.${contactHash}.${expStr}`)
    .digest("hex")
    .slice(0, 32);
  // Constant-time. A `!==` on hex leaks position of first difference, which is
  // enough to forge a MAC byte by byte given a spare afternoon.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expStr) < Date.now()) return null;
  return { orgId, contactHash };
}

/**
 * Verify a generic-entry code. On success:
 *  - single match → mint the session and return { token, slug } to redirect.
 *  - multiple matches → set a short-lived signed pick cookie and return a
 *    masked candidate list; the caller then calls portalChooseClient.
 */
export async function portalVerifyGeneric(
  slug: string,
  contactRaw: string,
  code: string,
): Promise<
  | { status: "verified"; slug: string; token: string }
  | { status: "choose"; slug: string; candidates: Array<{ id: string; label: string }> }
> {
  const org = await orgBrandingBySlug(slug);
  if (!org) throw new Error("We couldn't find that company.");
  const c = normalizeContact(contactRaw);
  if (!c) throw new Error("Enter a valid phone number or email.");
  const matches = await matchClients(org.organizationId, c);
  if (matches.length === 0) throw new Error("Request a new code.");

  // The OTP was issued against the first match's token; verify against it but
  // WITHOUT minting its session (we may mint for a different chosen client).
  await consumeOtpForClient(matches[0].client_id, code);

  const slugResolved = org.orgSlug ?? slug;
  if (matches.length === 1) {
    await createPortalSession(matches[0].token, matches[0].client_id, org.organizationId);
    return { status: "verified", slug: slugResolved, token: matches[0].token };
  }

  const { setCookie } = await reqres();
  const exp = Date.now() + 5 * 60_000;
  setCookie(PICK_COOKIE, signPick(org.organizationId, canonicalContact(c), exp), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 300,
  });
  return {
    status: "choose",
    slug: slugResolved,
    candidates: matches.map((m) => ({
      id: m.client_id,
      label: [maskName(m.display_name), maskStreet(m.street)].filter(Boolean).join(" · "),
    })),
  };
}

const ORG_CODE_MAX_ATTEMPTS_PER_IP = 10; // per 10-minute window

/**
 * Generic "I already have a code" entry: the client has a code (e.g. read to
 * them by the office) but hasn't identified with phone/email. Match the code
 * against the org's active OTPs and open that client's portal. IP-rate-limited
 * because a wrong code matches no specific OTP (so there's no per-code attempt
 * counter to lean on).
 */
export async function portalRedeemOrgCode(
  slug: string,
  code: string,
): Promise<{ slug: string; token: string }> {
  const org = await orgBrandingBySlug(slug);
  if (!org) throw new Error("We couldn't find that company.");
  const supabaseAdmin = await sbAdmin();
  const ip = await callerIp();
  const windowStart = new Date(Date.now() - 10 * 60_000).toISOString();

  // IP rate limit.
  if (ip) {
    const { count } = await supabaseAdmin
      .from("portal_code_attempts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.organizationId)
      .eq("ip", ip)
      .gte("created_at", windowStart);
    if ((count ?? 0) >= ORG_CODE_MAX_ATTEMPTS_PER_IP) {
      throw new Error(
        "Too many attempts. Please wait a few minutes, or use your phone/email instead.",
      );
    }
  }
  // Log this attempt regardless of outcome.
  await supabaseAdmin
    .from("portal_code_attempts")
    .insert({ organization_id: org.organizationId, ip });

  // Match the code against the org's active (unconsumed, unexpired) OTPs.
  const nowIso = new Date().toISOString();
  const submitted = sha256(code.trim());
  const { data: candidates } = await supabaseAdmin
    .from("portal_otps")
    .select("id, client_id, code_hash, clients!inner(organization_id, portal_token, active)")
    .is("consumed_at", null)
    .gte("expires_at", nowIso)
    .eq("clients.organization_id", org.organizationId)
    .eq("clients.active", true)
    .order("created_at", { ascending: false })
    .limit(200);

  let matched: { otpId: string; clientId: string; token: string } | null = null;
  for (const row of (candidates ?? []) as any[]) {
    const expected = row.code_hash as string;
    if (
      submitted.length === expected.length &&
      timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))
    ) {
      const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
      matched = { otpId: row.id, clientId: row.client_id, token: client.portal_token };
      break;
    }
  }
  if (!matched) throw new Error("That code isn't valid or has expired. Request a new one.");

  await supabaseAdmin.from("portal_otps").update({ consumed_at: nowIso }).eq("id", matched.otpId);
  await createPortalSession(matched.token, matched.clientId, org.organizationId);
  return { slug: org.orgSlug ?? slug, token: matched.token };
}

/** Validate + consume an OTP for a client without minting a session. */
/**
 * THE single OTP verification used by every flow: check the client's latest
 * unconsumed code (expiry + attempt-limit + constant-time compare), then
 * consume it. Throws a user-facing message on any failure. Callers mint the
 * session separately (createPortalSession) so the same check serves both the
 * pre-identified token flow and the generic/multi-match flows.
 */
async function consumeOtpForClient(clientId: string, code: string): Promise<void> {
  const supabaseAdmin = await sbAdmin();
  const { data: otp } = await supabaseAdmin
    .from("portal_otps")
    .select("id, code_hash, expires_at, consumed_at, attempts")
    .eq("client_id", clientId)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!otp) throw new Error("Request a new code.");
  if (new Date(otp.expires_at).getTime() < Date.now())
    throw new Error("That code expired. Request a new one.");
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new Error("Too many attempts. Request a new code.");
  const submitted = sha256(code.trim());
  const expected = otp.code_hash as string;
  const ok =
    submitted.length === expected.length &&
    timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
  if (!ok) {
    await supabaseAdmin
      .from("portal_otps")
      .update({ attempts: otp.attempts + 1 })
      .eq("id", otp.id);
    throw new Error("Incorrect code.");
  }
  await supabaseAdmin
    .from("portal_otps")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", otp.id);
}

/**
 * After a multi-match verify, mint the session for the chosen client. The pick
 * cookie proves the contact was just verified; the chosen client must still be
 * a current match for that org+contact.
 */
export async function portalChooseClient(
  chosenClientId: string,
): Promise<{ slug: string; token: string }> {
  const { getCookie } = await reqres();
  const proof = verifyPick(getCookie(PICK_COOKIE));
  if (!proof) throw new Error("Your session expired. Please verify again.");

  const supabaseAdmin = await sbAdmin();
  const { data: client } = await supabaseAdmin
    .from("clients")
    .select(
      "id, organization_id, portal_token, primary_phone, primary_email, active, organizations(portal_slug)",
    )
    .eq("id", chosenClientId)
    .maybeSingle();
  if (!client || !client.active || client.organization_id !== proof.orgId) {
    throw new Error("That account is no longer available.");
  }
  // Confirm the chosen client still matches the just-verified contact.
  const phoneHash = client.primary_phone
    ? sha256(client.primary_phone.replace(/\D/g, "").slice(-10))
    : null;
  const emailHash = client.primary_email ? sha256(client.primary_email.toLowerCase()) : null;
  if (proof.contactHash !== phoneHash && proof.contactHash !== emailHash) {
    throw new Error("That account is no longer available.");
  }
  await createPortalSession(client.portal_token, client.id, client.organization_id);
  const { deleteCookie } = await reqres();
  try {
    deleteCookie(PICK_COOKIE, { path: "/" });
  } catch {
    /* best effort */
  }
  const org: any = Array.isArray(client.organizations)
    ? client.organizations[0]
    : client.organizations;
  return { slug: org?.portal_slug ?? "", token: client.portal_token };
}
