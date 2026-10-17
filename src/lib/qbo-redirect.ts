// The parts of the QuickBooks OAuth flow that need no secret: the redirect
// URI, the CSRF state, and the words for each way the callback can fail.
// Imported by the callback route, the connect function and the settings page.

export const QBO_CALLBACK_PATH = "/api/public/hooks/qbo-callback";

/** A state is good for ten minutes and one use. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The redirect URI sent to Intuit. It must be one registered on the Intuit
 * app, which is `https://app.houndstack.com/api/public/hooks/qbo-callback`
 * in production. So the browser's origin is used only when it IS the app's
 * origin, or a local development server (Intuit's development keys accept
 * http://localhost). Anything else falls back to the app's origin, so a
 * caller cannot point the callback, and the code it carries, at another host.
 */
export function qboRedirectUri(requestedOrigin: string, appOrigin: string): string {
  let origin = appOrigin.replace(/\/+$/, "");
  try {
    const u = new URL(requestedOrigin);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.origin === origin || (local && (u.protocol === "http:" || u.protocol === "https:"))) {
      origin = u.origin;
    }
  } catch {
    /* not a URL: use the app's origin */
  }
  return `${origin}${QBO_CALLBACK_PATH}`;
}

/** 256 bits from the platform CSPRNG, as hex. */
export function newOAuthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type OAuthStateRow = { org_id: string; provider: string; expires_at: string };

/** Is a stored state good for a QuickBooks callback right now? */
export function checkOAuthState(
  row: OAuthStateRow | null,
  now: number,
): "ok" | "state_invalid" | "state_expired" {
  if (!row || row.provider !== "quickbooks") return "state_invalid";
  if (!(Date.parse(row.expires_at) > now)) return "state_expired";
  return "ok";
}

/** `?qbo_error=<code>` on Settings → Accounting, and what it says. */
export const QBO_CALLBACK_ERRORS = {
  access_denied: "QuickBooks wasn't connected: the request was canceled on Intuit's page.",
  missing_params: "QuickBooks sent the browser back without what it needed. Try connecting again.",
  state_invalid:
    "That connect link wasn't started from this page, or was already used, so it was refused. Start again with the Connect button.",
  state_expired: "The connect request took longer than ten minutes and expired. Start again with the Connect button.",
  not_configured: "QuickBooks isn't set up on this server yet. Contact support.",
  token_exchange: "Intuit didn't accept the sign-in. Try connecting again; if it keeps happening, contact support.",
  save_failed: "QuickBooks connected, but the connection couldn't be saved. Try again or contact support.",
} as const;

export type QboCallbackError = keyof typeof QBO_CALLBACK_ERRORS;

export function qboCallbackErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return (QBO_CALLBACK_ERRORS as Record<string, string>)[code] ?? QBO_CALLBACK_ERRORS.token_exchange;
}
