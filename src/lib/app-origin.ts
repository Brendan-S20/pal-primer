// The one place that says where this app lives.
//
// ── THE FINDING, AND ITS RESOLUTION ───────────────────────────────────────
//
// On 2026-08-02 `app.houndstack.com` did not serve this app. It 307-redirected
// to `www.app.houndstack.com` — a blanket "redirect to www" rule at the CDN
// that caught the `app` subdomain along with the apex. A CORS preflight may not
// follow a redirect (the Fetch spec makes it a network error), so the native
// app pointed at the documented host could not call a single server function,
// and outbound webhook POSTs were delivered to the 307 and dropped.
//
// The owner removed that rule the same day. Re-probed immediately after:
//
//     app.houndstack.com          GET / → 307 /auth  (its own routing, fine)
//                                 preflight → 204, allow-origin + expose-headers
//     www.app.houndstack.com      GET / → 302 to the bare host
//                                 preflight → 307   ← now the broken one
//
// So the direction has REVERSED, and this constant reversed with it. The bare
// host is authoritative, which is what every doc and comment in the repo said
// all along; the www form is now the redirect. `scripts/check-app-origin.mjs`
// is what caught the flip, and a test pins its copy of this constant to this
// one so the two cannot drift.
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

const FALLBACK = "https://app.houndstack.com";

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
