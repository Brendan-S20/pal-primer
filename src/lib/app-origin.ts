// The one place that says where this app lives.
//
// ── THE FINDING ────────────────────────────────────────────────────────────
//
// `app.houndstack.com` does not serve this app. It 307-redirects to
// `www.app.houndstack.com` — a blanket "redirect to www" rule at the CDN that
// caught the `app` subdomain along with the apex. Verified live on 2026-08-02:
//
//     curl -i -X OPTIONS https://app.houndstack.com/_serverFn/getMyDay \
//       -H 'Origin: capacitor://localhost' -H 'Access-Control-Request-Method: POST'
//     → HTTP/2 307, location: https://www.app.houndstack.com/_serverFn/getMyDay
//
//     …the same request to www.app.houndstack.com
//     → HTTP/2 204, access-control-allow-origin: capacitor://localhost,
//       access-control-expose-headers: x-tss-serialized, x-tss-raw
//
// **A CORS preflight may not follow redirects.** The Fetch spec makes a
// redirect on a preflight a network error, full stop — so the native app
// pointed at `app.houndstack.com` cannot call a single server function, while
// the identical request to the www host succeeds with every header the app
// needs, including the `expose-headers` pair BUG-62 was hiding in.
//
// So the CORS and CSRF work is correct. The host was wrong. That is the answer
// to §3 item 6 of the brief, which was waiting on someone to run two curls.
//
// The same applies to any server-to-server caller: outbound webhook senders do
// not follow redirects on POST, so a callback URL on the bare host is delivered
// to a 307 and dropped. `HoundStack_ClaudeCode_Tasks.md` already recorded this
// in a note — and the code was never made to match it, which is how a written
// finding becomes a bug that is technically already known.
//
// ── WHY A DEFAULT AT ALL, AND WHY THIS ONE ────────────────────────────────
//
// Before this file, twenty-four places in `src/` wrote an app host by hand and
// they did not agree: portal links, unsubscribe URLs, invoice pay links and the
// og:url canonical used the bare host, while invite emails, the concerns link,
// the lead-form origin and both Twilio hooks used the www one. One fact, two
// spellings, and which one you got depended on which file happened to build
// your URL.
//
// The default here is the host that ANSWERS, not the host that is documented.
// If the CDN redirect is removed so `app.houndstack.com` serves directly, this
// is the single line to change — and `APP_ORIGIN` in the environment overrides
// it without a deploy in the meantime.

const FALLBACK = "https://www.app.houndstack.com";

/** Trailing slashes make `${origin}/path` produce `//path`. */
const clean = (v: string) => v.trim().replace(/\/+$/, "");

/**
 * The scheme+host this app is reachable at, with no trailing slash.
 *
 * Reads three names because three already existed and silently disagreeing
 * with a deployment's configuration is worse than reading one extra variable:
 *
 *   * `APP_ORIGIN` — the name to use going forward.
 *   * `PUBLIC_APP_ORIGIN` — what the Twilio hooks already read to rebuild the
 *     canonical URL for signature validation. That one is security-critical:
 *     the string must match what Twilio signed, character for character.
 *   * `APP_URL` — what portal links, invoices and notifications already read.
 *
 * Safe to call from client code: `process` is guarded, so a browser bundle gets
 * the fallback rather than a ReferenceError.
 */
export function appOrigin(): string {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const configured = env?.APP_ORIGIN || env?.PUBLIC_APP_ORIGIN || env?.APP_URL;
  return configured ? clean(configured) : FALLBACK;
}

/**
 * `appOrigin()` joined to a path.
 *
 * Exists so callers stop writing `${appOrigin()}/portal/${token}` and getting
 * the slash wrong in one of the twenty-four places.
 */
export function appUrl(path = "/"): string {
  return `${appOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}
