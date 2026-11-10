// The link inside an auth email, built by the send-email hook
// (src/routes/email/auth/webhook.ts).
//
// Supabase's hook payload carries a token_hash, not a URL. For most email
// types the link is Supabase's hosted verify endpoint, which checks the token
// and then redirects to `redirect_to`. For a PASSWORD RESET that redirect is
// the weak point (2026-11-09):
//
//   * Supabase only redirects to an allow-listed URL, and the list held exact
//     roots with no `/**`, so `/reset-password` fell back to the site URL,
//     the bare root, and the recovery arrived somewhere that did not expect it.
//   * The hosted endpoint spends the token on a GET, so a mail scanner that
//     prefetches links can use up a reset before the person clicks it.
//
// So a recovery link points at the app's own /reset-password with the
// token_hash, and the page verifies it with verifyOtp({ type: "recovery" }).
// No redirect, no allow-list, and nothing is spent until JavaScript runs in a
// real browser. The one exception is a reset requested inside the iOS app:
// that has to come back through the app's custom scheme, which only the
// hosted endpoint can redirect to.

import { NATIVE_OAUTH_REDIRECT } from "@/lib/native-oauth-redirect";

export type AuthEmailLinkInput = {
  supabaseUrl: string;
  tokenHash: string;
  type: string;
  /** email_data.redirect_to from the hook payload; may be empty. */
  redirectTo: string | null | undefined;
  /** email_data.site_url from the hook payload. */
  siteUrl: string | null | undefined;
  /** appOrigin(): the canonical host this deployment serves. */
  appOrigin: string;
};

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function hostedVerifyUrl(i: AuthEmailLinkInput): string {
  const back = i.redirectTo || i.siteUrl || i.appOrigin;
  return (
    `${i.supabaseUrl.replace(/\/+$/, "")}/auth/v1/verify` +
    `?token=${encodeURIComponent(i.tokenHash)}` +
    `&type=${encodeURIComponent(i.type)}` +
    `&redirect_to=${encodeURIComponent(back)}`
  );
}

/**
 * The URL the email's button opens. A recovery goes straight to
 * /reset-password on the app (on the origin it was requested from when that
 * is this app or Supabase's site URL, otherwise the canonical one); every
 * other type, and a recovery for the iOS app, goes through Supabase's hosted
 * verify endpoint as before.
 */
export function authEmailLink(i: AuthEmailLinkInput): string {
  if (i.type !== "recovery") return hostedVerifyUrl(i);
  if (i.redirectTo && i.redirectTo.startsWith(NATIVE_OAUTH_REDIRECT)) return hostedVerifyUrl(i);

  const canonical = i.appOrigin.replace(/\/+$/, "");
  const trusted = new Set([canonical, originOf(i.siteUrl)].filter(Boolean) as string[]);
  const asked = originOf(i.redirectTo);
  const origin = asked && trusted.has(asked) ? asked : canonical;
  return (
    `${origin}/reset-password` + `?token_hash=${encodeURIComponent(i.tokenHash)}&type=recovery`
  );
}
