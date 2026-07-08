// Server-only portal authentication: OTP issue/verify + short-lived session
// cookies. The {uuid} in the URL only identifies WHICH client's portal is
// being requested; unlocking it requires a one-time code sent to the contact
// on file, which mints a 30-day session. See QA finding #4.
//
// Import inside server-function handlers only (uses service_role + cookies).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie, getRequestIP, getRequestHeader } from "@tanstack/react-start/server";

const COOKIE_PREFIX = "hs_portal_";
const SESSION_TTL_DAYS = 30;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5; // guesses per issued code
const OTP_MIN_INTERVAL_MS = 30_000; // between requests for one client
const OTP_MAX_PER_CLIENT_HOUR = 5;
const OTP_MAX_PER_IP_HOUR = 15;

/** Thrown when a portal action is attempted without a valid session. */
export class PortalVerificationRequired extends Error {
  code = "PORTAL_VERIFICATION_REQUIRED" as const;
  constructor() {
    super("PORTAL_VERIFICATION_REQUIRED");
  }
}

// portal_sessions / portal_otps and the portal_resolve_contact RPC are added
// by the finding-#4 migration; the generated Supabase types lag until Lovable
// regenerates them, so this module talks to the admin client untyped.
async function sbAdmin(): Promise<any> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function cookieName(token: string): string {
  // Scope the cookie to the specific client token so one device holding links
  // to two different clients keeps separate sessions.
  return COOKIE_PREFIX + sha256(token).slice(0, 16);
}

function callerIp(): string | null {
  try {
    return getRequestIP({ xForwardedFor: true }) ?? null;
  } catch {
    return null;
  }
}

type ContactRow = {
  client_id: string;
  organization_id: string;
  display_name: string;
  primary_phone: string | null;
  primary_email: string | null;
  org_name: string;
};

async function resolveContact(token: string): Promise<ContactRow | null> {
  const supabaseAdmin = await sbAdmin();
  const { data, error } = await supabaseAdmin.rpc("portal_resolve_contact", { _token: token });
  if (error) throw new Error(error.message);
  return ((data as any[])?.[0] as ContactRow) ?? null;
}

function maskPhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• •••• ${digits.slice(-4)}` : "your phone";
}
function maskEmail(e: string): string {
  const [user, domain] = e.split("@");
  if (!domain) return "your email";
  const head = user.slice(0, Math.min(2, user.length));
  return `${head}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

export type PortalChannel = "sms" | "email";

export type PortalContact = {
  clientId: string;
  organizationId: string;
  channels: Array<{ channel: PortalChannel; hint: string }>;
};

/** Channels we can send an OTP to, with masked hints for the UI. */
export async function portalContactChannels(token: string): Promise<PortalContact | null> {
  const c = await resolveContact(token);
  if (!c) return null;
  const channels: PortalContact["channels"] = [];
  if (c.primary_phone) channels.push({ channel: "sms", hint: maskPhone(c.primary_phone) });
  if (c.primary_email) channels.push({ channel: "email", hint: maskEmail(c.primary_email) });
  return { clientId: c.client_id, organizationId: c.organization_id, channels };
}

/**
 * Return the active session's client_id for this token, or null if the caller
 * must verify. Also refreshes last_seen_at. A session is only valid for the
 * client the token currently points to — rotating the token (Regenerate)
 * orphans every old session.
 */
export async function getPortalSession(token: string): Promise<{ clientId: string; organizationId: string } | null> {
  const raw = getCookie(cookieName(token));
  if (!raw) return null;
  const supabaseAdmin = await sbAdmin();
  const contact = await resolveContact(token);
  if (!contact) return null; // token rotated or client deactivated

  const { data: sess } = await supabaseAdmin
    .from("portal_sessions")
    .select("id, client_id, organization_id, expires_at, revoked_at")
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
  return { clientId: sess.client_id, organizationId: sess.organization_id };
}

/** Throws PortalVerificationRequired unless a valid session exists. */
export async function requirePortalSession(token: string): Promise<{ clientId: string; organizationId: string }> {
  const s = await getPortalSession(token);
  if (!s) throw new PortalVerificationRequired();
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
  if (!dest) throw new Error(`No ${channel === "sms" ? "phone" : "email"} on file for this account`);
  const hint = channel === "sms" ? maskPhone(dest) : maskEmail(dest);
  const ip = callerIp();
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();

  // Rate limits.
  const { data: recent } = await supabaseAdmin
    .from("portal_otps")
    .select("created_at")
    .eq("client_id", contact.client_id)
    .order("created_at", { ascending: false })
    .limit(OTP_MAX_PER_CLIENT_HOUR);
  const recentRows = recent ?? [];
  if (recentRows[0] && Date.now() - new Date(recentRows[0].created_at).getTime() < OTP_MIN_INTERVAL_MS) {
    throw new Error("Please wait a moment before requesting another code.");
  }
  if (recentRows.filter((r: { created_at: string }) => r.created_at >= hourAgo).length >= OTP_MAX_PER_CLIENT_HOUR) {
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
  await supabaseAdmin.from("portal_otps").insert({
    client_id: contact.client_id,
    code_hash: sha256(code),
    channel,
    destination_hint: hint,
    expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
    request_ip: ip,
  });

  const message = `${contact.org_name}: your verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`;
  try {
    if (channel === "sms") {
      const { data: org } = await supabaseAdmin
        .from("organizations")
        .select("sms_from_number")
        .eq("id", contact.organization_id)
        .single();
      if (!org?.sms_from_number) throw new Error("SMS is not configured — ask us to read you the code.");
      const { sendTwilioSms } = await import("@/lib/twilio.server");
      await sendTwilioSms({ from: org.sms_from_number, to: dest, body: message });
    } else {
      await supabaseAdmin.rpc("enqueue_email", {
        queue_name: "transactional_emails",
        payload: {
          message_id: `portal-otp-${sha256(code).slice(0, 12)}`,
          to: dest,
          from: `${contact.org_name} <noreply@notify.thenorth.consulting>`,
          sender_domain: "notify.thenorth.consulting",
          subject: `Your ${contact.org_name} verification code`,
          html: `<p>Your verification code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p><p>It expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this, ignore this email.</p>`,
          text: message,
          purpose: "transactional",
          label: "portal-otp",
          queued_at: new Date().toISOString(),
        },
      });
    }
  } catch (e) {
    // The code is stored regardless, so the owner-side "read code" fallback
    // still works even if delivery fails.
    console.error("portal OTP delivery failed", (e as Error).message);
    throw new Error(
      (e as Error).message || "Could not send the code. Ask us to read it to you instead.",
    );
  }

  return { sent: true, hint, channel };
}

/**
 * Mint a single-use code for the office to read aloud to a client who can't
 * receive SMS/email. Returns the plaintext code (this path is owner-gated in
 * the calling server function; the code is never sent anywhere automatically).
 */
export async function issueOfficeReadCode(clientId: string): Promise<{ code: string; hint: string }> {
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
  const supabaseAdmin = await sbAdmin();
  const contact = await resolveContact(token);
  if (!contact) throw new Error("Invalid portal link");

  const { data: otp } = await supabaseAdmin
    .from("portal_otps")
    .select("id, code_hash, expires_at, consumed_at, attempts")
    .eq("client_id", contact.client_id)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!otp) throw new Error("Request a new code.");
  if (new Date(otp.expires_at).getTime() < Date.now()) throw new Error("That code expired. Request a new one.");
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new Error("Too many attempts. Request a new code.");

  const submitted = sha256(code.trim());
  const expected = otp.code_hash as string;
  const ok =
    submitted.length === expected.length &&
    timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
  if (!ok) {
    await supabaseAdmin.from("portal_otps").update({ attempts: otp.attempts + 1 }).eq("id", otp.id);
    throw new Error("Incorrect code.");
  }

  await supabaseAdmin.from("portal_otps").update({ consumed_at: new Date().toISOString() }).eq("id", otp.id);

  const secret = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await supabaseAdmin.from("portal_sessions").insert({
    client_id: contact.client_id,
    organization_id: contact.organization_id,
    token_hash: sha256(secret),
    expires_at: expiresAt.toISOString(),
    ip: callerIp(),
    user_agent: (() => {
      try {
        return getRequestHeader("user-agent") ?? null;
      } catch {
        return null;
      }
    })(),
  });

  setCookie(cookieName(token), secret, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/portal",
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
  return true;
}
