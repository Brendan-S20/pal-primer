// Password reset, end to end: asking for the email, recognising the link
// when it comes back, and keeping everything else out of the way until a new
// password is set.
//
// ── WHY THIS FILE EXISTS (2026-11-09) ─────────────────────────────────────
//
// A pilot owner could not reset a password, and every piece of the flow was
// wrong in a different way:
//
//   * /auth asked for `${window.location.origin}/reset-password`, the profile
//     page for `${appOrigin()}/auth`. Neither is on Supabase's redirect
//     allow-list (it holds exact roots, no `/**`), so Supabase sends the link
//     to the SITE URL, the bare root, instead.
//   * The root redirects to /auth. A `#access_token=…&type=recovery` hash
//     survives that; supabase-js turns it into a session, and /auth's landing
//     effect then treated a person who had forgotten their password as signed
//     in: ensureBootstrapped ran, and for an account with no role and an
//     `org_name` in its metadata, it minted a brand-new organization. The
//     password was never changed.
//   * A `?code=` or `?token_hash=` link was dropped by the same redirect.
//   * A failed request (the send-email hook unreachable, a rate limit) showed
//     Supabase's raw message, and the profile page could show "sent" for a
//     link that went nowhere useful.
//
// So: one helper builds the request (`requestPasswordReset`), one parser
// reads a returning link (`readRecoveryLink`), and one flag, captured at boot
// before supabase-js strips the hash, says "this tab is mid-recovery" so the
// landing and bootstrap code stand aside until /reset-password is done.
//
// → tests/a-password-reset-that-goes-somewhere.test.ts

import { appUrl, linkOrigin } from "@/lib/app-origin";
import { NATIVE_OAUTH_REDIRECT } from "@/lib/native-oauth-redirect";

export const RESET_PASSWORD_PATH = "/reset-password";
export const SUPPORT_EMAIL = "support@houndstack.com";

// ── THE REQUEST ───────────────────────────────────────────────────────────

/**
 * Where the reset email's link should bring the person back to.
 *
 * Web: the app's own /reset-password on the canonical origin (`linkOrigin()`,
 * which is this page's origin unless it is a short-lived preview host).
 *
 * iOS app: the custom scheme the binary registers (Info.plist
 * CFBundleURLTypes) and Supabase already allow-lists. lib/app-url-open.ts
 * sees `type=recovery` on it and opens /reset-password inside the app.
 *
 * Android app: the web page. The Android manifest registers no custom scheme
 * (only https App Links), so a scheme link would open nothing; and
 * /reset-password is deliberately not claimed by the app
 * (lib/android-app-links.ts), so the link opens the browser, the password is
 * changed there, and the person signs in to the app with it.
 */
export function passwordResetRedirect(opts: {
  platform: "web" | "ios" | "android";
  origin: string;
}): string {
  if (opts.platform === "ios") return NATIVE_OAUTH_REDIRECT;
  return `${opts.origin.replace(/\/+$/, "")}${RESET_PASSWORD_PATH}`;
}

/** The shape of a supabase-js AuthError, as far as this file reads it. */
export type ResetErrorLike = {
  message?: string | null;
  status?: number | null;
  code?: string | null;
  name?: string | null;
};

export const RESET_SEND_FAILED =
  `We couldn't send the reset email right now. Try again in a few minutes ` +
  `or contact ${SUPPORT_EMAIL}.`;
export const RESET_RATE_LIMITED =
  "Too many reset requests. Wait a minute, then try again. If an email already " +
  "arrived, use the newest link in it.";
export const RESET_BAD_EMAIL = "Enter the email address you sign in with.";

/**
 * What a person reads when the request failed. Never Supabase's raw text:
 * "Error sending recovery email" (the send hook could not be reached) and
 * "For security purposes, you can only request this after 52 seconds" are
 * true, but neither says what to do.
 */
export function describeResetError(err: ResetErrorLike): string {
  const msg = (err.message ?? "").toLowerCase();
  const code = (err.code ?? "").toLowerCase();
  if (
    err.status === 429 ||
    code.includes("rate_limit") ||
    msg.includes("rate limit") ||
    msg.includes("security purposes") ||
    msg.includes("too many")
  ) {
    return RESET_RATE_LIMITED;
  }
  if (
    code === "email_address_invalid" ||
    code === "validation_failed" ||
    msg.includes("invalid email") ||
    msg.includes("unable to validate email")
  ) {
    return RESET_BAD_EMAIL;
  }
  // Everything else, the hook failures included (status 500, codes hook_*,
  // unexpected_failure, "Error sending recovery email"), is one message: the
  // person did nothing wrong and cannot fix it from here.
  return RESET_SEND_FAILED;
}

export type ResetRequestResult = { ok: true; sentTo: string } | { ok: false; message: string };

type ResetClient = {
  auth: {
    resetPasswordForEmail: (
      email: string,
      options?: { redirectTo?: string },
    ) => Promise<{ error: ResetErrorLike | null }>;
  };
};

/**
 * Ask Supabase to send a reset email. Every call site goes through here, so
 * there is one redirect and one set of error messages. Never resolves `ok`
 * when Supabase said no: "Check your email" over a failed send is how a
 * person waits for a message that is never coming.
 */
export async function requestPasswordReset(
  client: ResetClient,
  email: string,
  redirectTo: string,
): Promise<ResetRequestResult> {
  const trimmed = email.trim();
  if (!/.+@.+\..+/.test(trimmed)) return { ok: false, message: RESET_BAD_EMAIL };
  try {
    const { error } = await client.auth.resetPasswordForEmail(trimmed, { redirectTo });
    if (error) return { ok: false, message: describeResetError(error) };
    return { ok: true, sentTo: trimmed };
  } catch (err) {
    // A network failure rejects rather than returning { error }.
    return { ok: false, message: describeResetError(err as ResetErrorLike) };
  }
}

/** The redirect for a request made in THIS browser or app. */
export async function passwordResetRedirectHere(): Promise<string> {
  let platform: "web" | "ios" | "android" = "web";
  if (import.meta.env.VITE_NATIVE_BUNDLE === "1") {
    const { Capacitor } = await import("@capacitor/core");
    const p = Capacitor.getPlatform();
    platform = p === "ios" || p === "android" ? p : "web";
  }
  // Android's API origin IS the canonical host (VITE_NATIVE_API_ORIGIN), so
  // linkOrigin() is the right web page for it too.
  return passwordResetRedirect({ platform, origin: linkOrigin() });
}

// ── THE LINK COMING BACK ──────────────────────────────────────────────────

export type RecoveryLink =
  /** PKCE: `?code=`. Exchanged with exchangeCodeForSession. */
  | { kind: "code"; code: string }
  /** `?token_hash=…&type=recovery`. Verified with verifyOtp. */
  | { kind: "token_hash"; tokenHash: string }
  /** Implicit: `#access_token=…&refresh_token=…&type=recovery`. */
  | { kind: "implicit"; accessToken: string; refreshToken: string }
  /** Supabase refused the link (expired, already used). */
  | { kind: "error"; description: string };

function parts(href: string): { search: URLSearchParams; hash: URLSearchParams } | null {
  let u: URL;
  try {
    u = new URL(href, "https://placeholder.invalid");
  } catch {
    return null;
  }
  return {
    search: u.searchParams,
    hash: new URLSearchParams(u.hash.startsWith("#") ? u.hash.slice(1) : u.hash),
  };
}

/** Error codes Supabase puts on a link it would not honour. */
const LINK_ERROR_CODES = new Set([
  "otp_expired",
  "otp_disabled",
  "flow_state_expired",
  "flow_state_not_found",
  "bad_code_verifier",
]);

/**
 * Read a URL for a password-recovery hand-back, in any of the three shapes
 * Supabase produces, or null when it is not one.
 *
 * A bare `?code=` counts. This app's client is implicit-flow (see
 * lib/native-oauth.ts), so its own sign-ins never come back with a code; a
 * code arriving here came from a PKCE reset request, and /reset-password is
 * the one page that knows what to do with it.
 */
export function readRecoveryLink(href: string): RecoveryLink | null {
  const p = parts(href);
  if (!p) return null;
  const { search, hash } = p;
  const type = hash.get("type") ?? search.get("type");

  const errorCode = hash.get("error_code") ?? search.get("error_code");
  if (errorCode && (LINK_ERROR_CODES.has(errorCode) || type === "recovery")) {
    const description =
      hash.get("error_description") ??
      search.get("error_description") ??
      "Email link is invalid or has expired";
    return { kind: "error", description: description.replace(/\+/g, " ") };
  }

  const tokenHash = search.get("token_hash") ?? hash.get("token_hash");
  if (tokenHash && (type === "recovery" || type === null)) return { kind: "token_hash", tokenHash };

  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");
  if (type === "recovery" && accessToken && refreshToken) {
    return { kind: "implicit", accessToken, refreshToken };
  }

  const code = search.get("code");
  if (code && !search.get("error")) return { kind: "code", code };
  return null;
}

/** Pages a recovery link can arrive on: the site root (where Supabase sends
 *  a redirect that is not allow-listed), /auth (where the root redirects to)
 *  and /reset-password itself. A `?code=` anywhere else is that page's own
 *  parameter, not ours. */
const RECOVERY_LANDING_PATHS = new Set(["", "/", "/auth", RESET_PASSWORD_PATH]);

/**
 * The /reset-password path, with the link's query and hash carried along so
 * that page can finish the exchange, for a URL that is a recovery hand-back.
 * Null for anything else.
 *
 * Accepts the native custom-scheme hand-back too
 * (consulting.thenorth.houndstack://auth-callback#…&type=recovery), which is
 * how lib/app-url-open.ts turns a recovery link that opened the app into an
 * in-app page.
 */
export function recoveryForwardPath(href: string): string | null {
  const link = readRecoveryLink(href);
  if (!link) return null;
  let u: URL;
  try {
    u = new URL(href, "https://placeholder.invalid");
  } catch {
    return null;
  }
  const native = href.startsWith(NATIVE_OAUTH_REDIRECT);
  if (
    !native &&
    link.kind === "code" &&
    !RECOVERY_LANDING_PATHS.has(u.pathname.replace(/\/+$/, "") || "/")
  ) {
    return null;
  }
  return `${RESET_PASSWORD_PATH}${u.search}${u.hash}`;
}

// ── "THIS TAB IS MID-RECOVERY" ────────────────────────────────────────────
//
// supabase-js reads an implicit-flow hash on its own, at client start, and
// then removes it from the address bar. By the time /auth's effect runs the
// URL is clean and a session exists, indistinguishable from a sign-in. So the
// URL is read once at boot, synchronously, before the client's asynchronous
// initialisation gets to it (src/routes/__root.tsx), and the answer is kept
// in this tab's sessionStorage for as long as a recovery link can live.

const FLAG_KEY = "hs-password-recovery";
/** Supabase's recovery links last an hour by default; a flag older than that
 *  is a reset somebody walked away from, and must not trap a later sign-in. */
export const RECOVERY_FLAG_TTL_MS = 60 * 60_000;

type FlagStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): FlagStore | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function markRecoveryPending(
  store: FlagStore | null = sessionStore(),
  now = Date.now(),
): void {
  try {
    store?.setItem(FLAG_KEY, String(now));
  } catch {
    // Private mode with storage off: the URL check still covers this load.
  }
}

export function clearRecoveryPending(store: FlagStore | null = sessionStore()): void {
  try {
    store?.removeItem(FLAG_KEY);
  } catch {
    // nothing to clear
  }
}

export function isRecoveryPending(
  store: FlagStore | null = sessionStore(),
  now = Date.now(),
): boolean {
  let raw: string | null = null;
  try {
    raw = store?.getItem(FLAG_KEY) ?? null;
  } catch {
    return false;
  }
  if (!raw) return false;
  const at = Number(raw);
  if (!Number.isFinite(at) || now - at > RECOVERY_FLAG_TTL_MS) {
    clearRecoveryPending(store);
    return false;
  }
  return true;
}

/** The link this page was loaded with, if it was a recovery link. */
let bootLink: { href: string; link: RecoveryLink } | null = null;

/**
 * Called once, at module load on the client, before supabase-js has had a
 * chance to consume the hash. Remembers the link and raises the flag.
 */
export function captureRecoveryFromUrl(
  href: string,
  store: FlagStore | null = sessionStore(),
): RecoveryLink | null {
  const link = readRecoveryLink(href);
  if (!link) return null;
  bootLink = { href, link };
  markRecoveryPending(store);
  return link;
}

/** Where /auth or the root should send this tab instead of landing it, or
 *  null when it is not mid-recovery. Carries the original link along when the
 *  page still has it, so /reset-password can finish the exchange itself. */
export function recoveryRedirectTarget(
  currentHref: string,
  store: FlagStore | null = sessionStore(),
): string | null {
  const here = recoveryForwardPath(currentHref);
  if (here) return here;
  if (bootLink) {
    const fromBoot = recoveryForwardPath(bootLink.href);
    // The boot link is spent once supabase-js has turned it into a session;
    // carrying a used hash would only replay it. Plain path then.
    bootLink = null;
    if (fromBoot)
      return fromBoot.startsWith(`${RESET_PASSWORD_PATH}#`) ? RESET_PASSWORD_PATH : fromBoot;
  }
  return isRecoveryPending(store) ? RESET_PASSWORD_PATH : null;
}

/** Tests only. */
export function __resetPasswordRecoveryForTests(): void {
  bootLink = null;
}

// ── TURNING THE LINK INTO A SESSION, ON /reset-password ───────────────────

export const RESET_LINK_INVALID =
  "This reset link is invalid or has expired. Links work once and last an hour. " +
  "Send yourself a new one below.";

type RecoveryClient = {
  auth: {
    getSession: () => Promise<{ data: { session: unknown | null } }>;
    exchangeCodeForSession: (code: string) => Promise<{ error: ResetErrorLike | null }>;
    verifyOtp: (p: {
      token_hash: string;
      type: "recovery";
    }) => Promise<{ error: ResetErrorLike | null }>;
    setSession: (p: {
      access_token: string;
      refresh_token: string;
    }) => Promise<{ error: ResetErrorLike | null }>;
  };
};

export type EstablishResult = { ok: true } | { ok: false; message: string };

/**
 * Whatever shape the link arrived in, end with a session that may set a new
 * password, or say plainly that the link is no good. Called by
 * /reset-password with the URL it was opened at.
 *
 *   ?code=          exchangeCodeForSession (PKCE)
 *   ?token_hash=    verifyOtp({ type: "recovery" })
 *   #access_token=  already a session if supabase-js read the hash at start
 *                   (the web); setSession otherwise (an app link)
 *   #error_code=    Supabase refused it: expired or already used
 *   nothing         an existing session (the link was read on an earlier
 *                   page, or a signed-in person came here on purpose)
 */
export async function establishRecoverySession(
  client: RecoveryClient,
  href: string,
): Promise<EstablishResult> {
  const link = readRecoveryLink(href);
  const fail = (): EstablishResult => ({ ok: false, message: RESET_LINK_INVALID });
  try {
    if (link?.kind === "error") return fail();
    if (link?.kind === "code") {
      const { error } = await client.auth.exchangeCodeForSession(link.code);
      // A code with no verifier in THIS browser (the email was opened on
      // another device) cannot be exchanged. An existing recovery session
      // from the same click, read a moment earlier, still counts.
      if (error) return (await hasSession(client)) && isRecoveryPending() ? { ok: true } : fail();
      return { ok: true };
    }
    if (link?.kind === "token_hash") {
      const { error } = await client.auth.verifyOtp({
        token_hash: link.tokenHash,
        type: "recovery",
      });
      return error ? fail() : { ok: true };
    }
    if (link?.kind === "implicit") {
      if (await hasSession(client)) return { ok: true };
      const { error } = await client.auth.setSession({
        access_token: link.accessToken,
        refresh_token: link.refreshToken,
      });
      return error ? fail() : { ok: true };
    }
    return (await hasSession(client)) ? { ok: true } : fail();
  } catch {
    return fail();
  }
}

async function hasSession(client: RecoveryClient): Promise<boolean> {
  const { data } = await client.auth.getSession();
  return !!data.session;
}

// ── THE NEW PASSWORD ──────────────────────────────────────────────────────

export const MIN_PASSWORD_LENGTH = 8;

/** The form's own checks, before anything is sent. Null when it may go. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.trim().length === 0) return "Password can't be only spaces.";
  if (password !== confirm) return "Passwords don't match.";
  return null;
}

/** What updateUser's refusal means to the person typing. */
export function describeUpdatePasswordError(err: ResetErrorLike): {
  message: string;
  linkDead: boolean;
} {
  const msg = (err.message ?? "").toLowerCase();
  const code = (err.code ?? "").toLowerCase();
  if (code === "same_password" || msg.includes("different from the old")) {
    return { message: "That's your current password. Choose a new one.", linkDead: false };
  }
  if (
    code === "weak_password" ||
    msg.includes("weak") ||
    msg.includes("should be at least") ||
    msg.includes("should contain")
  ) {
    return {
      message: err.message
        ? `That password is too weak: ${err.message}`
        : "That password is too weak. Try a longer one.",
      linkDead: false,
    };
  }
  if (
    code === "session_not_found" ||
    code === "session_expired" ||
    msg.includes("session missing") ||
    err.status === 401 ||
    err.status === 403
  ) {
    return { message: RESET_LINK_INVALID, linkDead: true };
  }
  if (err.status === 429 || msg.includes("rate limit")) {
    return { message: "Too many attempts. Wait a minute, then try again.", linkDead: false };
  }
  return {
    message: `We couldn't update your password. Try again, or contact ${SUPPORT_EMAIL}.`,
    linkDead: false,
  };
}

/**
 * A redirect a server function was handed by the browser, kept only if it is
 * one this app would have built itself: the iOS scheme, or /reset-password on
 * an http(s) origin. Anything else (or nothing) becomes the canonical
 * /reset-password. Supabase's allow-list is the real gate on where a link
 * goes; this keeps a caller from asking for a page that cannot finish a
 * recovery, which is what the profile page's `/auth` did.
 */
export function safeResetRedirect(requested: string | undefined | null): string {
  const fallback = appUrl(RESET_PASSWORD_PATH);
  if (!requested) return fallback;
  if (requested === NATIVE_OAUTH_REDIRECT) return requested;
  try {
    const u = new URL(requested);
    if (
      (u.protocol === "https:" || u.protocol === "http:") &&
      u.pathname === RESET_PASSWORD_PATH &&
      !u.search &&
      !u.hash
    ) {
      return `${u.origin}${RESET_PASSWORD_PATH}`;
    }
  } catch {
    // not a URL
  }
  return fallback;
}
