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
//                                 preflight → 307   ← the broken one that day
//
// So the direction REVERSED, and this constant reversed with it. The bare host
// is authoritative, which is what every doc and comment in the repo said all
// along. `scripts/check-app-origin.mjs` is what caught the flip, and a test
// pins its copy of this constant to this one so the two cannot drift.
//
// ── AND THEN THE WWW HOST STOPPED EXISTING (2026-08-10) ───────────────────
//
// The block above is history, not current state. `www.app.houndstack.com` no
// longer resolves — NXDOMAIN, no A record, nothing to redirect from:
//
//     www.app.houndstack.com      DNS → NXDOMAIN
//     app.houndstack.com          185.158.133.1, GET / → 307 /auth (same host)
//
// Worth writing down because a dead host is a WORSE failure than a redirect
// and looks like nothing. A redirect at least answers; NXDOMAIN produces a
// connection error with no status code, which every dashboard renders as an
// unexplained red row. The Resend suppression webhook had been configured
// against the www host back when it still answered, and sat silently disabled
// for eight days after the record went away — bounces and spam complaints
// going nowhere, while the app kept sending mail perfectly well.
//
// The lesson that became a rule: a stale host does not spread through code,
// which this module already prevents. It spreads through COMMENTS that
// document a URL for someone to paste into a provider's dashboard. So the
// hardcoded-host test now also pins any `VERB https://…` comment line to this
// constant — see tests/one-app-origin.test.ts.
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

// ── LINKS BUILT IN THE BROWSER (#660) ─────────────────────────────────────
//
// `appOrigin()` answers from the SERVER's environment. In a browser there is
// no `process.env`, so every link a staff screen built with it (portal, pay,
// signup form, embed code, Preview, Download PDF) pointed at the production
// fallback whatever was actually running: a localhost dev server, a staging
// deploy, or a native build pointed at a local API. Android then left the app
// for Chrome and reached production with tokens that only exist locally.
//
// `linkOrigin()` is the browser's answer to the same question, in order:
//
//   1. A native bundle: the API origin baked in at build time
//      (VITE_NATIVE_API_ORIGIN). That is where the server functions already
//      go, so it is the host that holds the tokens this build can see. The
//      page origin there is capacitor://localhost or https://localhost, which
//      nobody else can open.
//   2. A page served over http(s): this page's own origin, unless it is a
//      Lovable preview host. A preview domain is a link that works today and
//      404s next week, so a link built there uses the canonical host, as it
//      always has.
//   3. Anything else, and the server: `appOrigin()`.
//
// In production all three give app.houndstack.com.

/** Hosts that serve a build for a while and then stop. */
const PREVIEW_HOST = /(^|\.)(lovable\.app|lovableproject\.com|lovable\.dev)$/i;

export type LinkOriginInputs = {
  /** `window.location`, or null where there is no page. */
  location: { protocol: string; hostname: string; origin: string } | null;
  /** The API origin baked into a native bundle; "" on the web. */
  nativeApiOrigin: string;
  /** True only in the bundle that ships inside the app binary. */
  nativeBundle: boolean;
  /** What to use when nothing better is known. */
  fallback: string;
};

/** The rule behind `linkOrigin()`, with its inputs passed in so it can be
 *  tested without a browser or a native build. */
export function resolveLinkOrigin(i: LinkOriginInputs): string {
  const api = clean(i.nativeApiOrigin);
  if (api) return api;
  // A native bundle with no API origin cannot happen (vite.config.ts always
  // sets one), but its page origin is never a link, so say so.
  if (i.nativeBundle || !i.location) return i.fallback;
  const { protocol, hostname } = i.location;
  if (protocol !== "https:" && protocol !== "http:") return i.fallback;
  if (PREVIEW_HOST.test(hostname)) return i.fallback;
  return clean(i.location.origin);
}

/**
 * Where a link built on THIS device should point: the API origin in a native
 * build, this page's origin on the web, `appOrigin()` on the server. Use it
 * for any portal, pay, signup, embed, preview or PDF link a staff screen
 * builds. Server code (emails, texts, webhooks) keeps `appUrl()`.
 */
export function linkOrigin(): string {
  return resolveLinkOrigin({
    location: typeof window !== "undefined" ? window.location : null,
    nativeApiOrigin: import.meta.env.VITE_NATIVE_API_ORIGIN ?? "",
    nativeBundle: import.meta.env.VITE_NATIVE_BUNDLE === "1",
    fallback: appOrigin(),
  });
}

/** `linkOrigin()` joined to a path. */
export function linkUrl(path = "/"): string {
  return `${linkOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}
