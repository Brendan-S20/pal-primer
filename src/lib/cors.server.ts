// CORS for the native app's server-function calls.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// BUILD-9 made the store app boot from a bundle. That moves it to its own
// origin — `capacitor://localhost` on iOS, `https://localhost` on Android — so
// every server-function call it makes is now CROSS-ORIGIN to
// app.houndstack.com. Nothing in this app set CORS headers on `/_serverFn/*`,
// so the browser's preflight would have been refused and the native app would
// have booted perfectly offline and then failed to reach the backend on full
// signal.
//
// ── WHY IT IS AN ALLOWLIST AND NOT A REFLECTOR ─────────────────────────────
//
// The obvious shortcuts are both wrong here. `Access-Control-Allow-Origin: *`
// would let any page on the internet call our server functions. Reflecting
// whatever Origin arrives is the same hole wearing a disguise. So: a fixed set,
// plus an env-configured extension for staging, and anything else gets no CORS
// headers at all — which the browser turns into a refusal, the correct default.
//
// ── WHY NO Access-Control-Allow-Credentials ────────────────────────────────
//
// Deliberate, and it matters more than usual here. This app authenticates
// server functions with a bearer token that attachSupabaseAuth reads out of the
// app's own storage — see src/integrations/supabase/auth-attacher.ts — not with
// a cookie. A page on another origin cannot read that storage, so it cannot
// forge an authenticated call.
//
// Turning credentials on would change that: cookies would ride along
// automatically on cross-origin requests, and this deployment currently has NO
// CSRF middleware (createStartHandler installs the default one only when the
// start instance supplies no requestMiddleware, and src/start.ts supplies one).
// Credentials plus no CSRF protection is the combination that turns a CORS
// entry into a session-riding vulnerability. Leaving it off keeps the bearer
// token as the only way in.
//
// ── WHY ONLY /_serverFn/ ───────────────────────────────────────────────────
//
// The native app needs exactly one thing cross-origin: the RPC endpoint. Pages,
// assets and the public webhooks have no reason to be readable by another
// origin's JavaScript, and widening the scope would expose them for nothing.

/** Capacitor's own origins. Not configurable — these are what the platforms
 *  produce, and a typo would silently break the app rather than being caught. */
const NATIVE_ORIGINS = [
  // iOS WKWebView, per capacitor.config.ts (iosScheme default).
  "capacitor://localhost",
  // Android, whose default androidScheme is https.
  "https://localhost",
] as const;

/**
 * Extra origins for staging or a device pointed at a preview build.
 *
 * Comma-separated in NATIVE_CORS_ORIGINS. Blank entries are dropped so a
 * trailing comma cannot allowlist the empty origin, and each is compared
 * whole — no prefix or suffix matching, because "starts with our domain" is how
 * `app.houndstack.com.evil.test` gets in.
 */
function configuredOrigins(env: string | undefined): string[] {
  return (env ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

export function allowedOrigins(env?: string | undefined): string[] {
  return [...NATIVE_ORIGINS, ...configuredOrigins(env)];
}

/** The RPC path prefix, and only that. */
export const CORS_PATH_PREFIX = "/_serverFn/";

/**
 * Headers the native client actually sends, so the preflight answer is not a
 * guess. `content-type` is `application/x-tss-framed…` and `x-tsr-serverFn` is
 * set by the RPC fetcher; `authorization` is the bearer token. Any of the three
 * is enough to force a preflight on its own.
 *
 * Lowercase because that is how browsers send Access-Control-Request-Headers;
 * matching is case-insensitive either way.
 */
const ALLOWED_REQUEST_HEADERS = "authorization, content-type, x-tsr-serverfn";

/**
 * Is this an origin the native app legitimately runs on?
 *
 * Shared with the CSRF middleware in src/start.ts deliberately: CSRF has to
 * make an exception for exactly the origins CORS admits, and two lists that
 * must agree are two lists that will eventually disagree. One definition, one
 * place to widen it, one place to get it wrong.
 */
export function isAllowedOrigin(origin: string | null, env?: string | undefined): boolean {
  if (!origin) return false;
  return allowedOrigins(env).includes(origin);
}

export type CorsDecision =
  | { kind: "ignore" }
  | { kind: "preflight"; headers: Record<string, string> }
  | { kind: "actual"; headers: Record<string, string> };

/**
 * What to do with a request, as a value rather than a side effect, so the rules
 * can be tested without a server.
 *
 * `ignore` means touch nothing — same-origin requests (which carry no Origin),
 * anything outside the RPC path, and any origin not on the list. An unknown
 * origin deliberately gets NO headers rather than a denial: the absence is what
 * the browser enforces, and emitting a header for it would be the start of
 * reflecting.
 */
export function corsDecision(input: {
  method: string;
  path: string;
  origin: string | null;
  env?: string | undefined;
}): CorsDecision {
  const { method, path, origin } = input;
  if (!origin) return { kind: "ignore" };
  if (!path.startsWith(CORS_PATH_PREFIX)) return { kind: "ignore" };
  if (!isAllowedOrigin(origin, input.env)) return { kind: "ignore" };

  const base: Record<string, string> = {
    "access-control-allow-origin": origin,
    // Without this a shared cache could hand a response carrying one origin's
    // CORS header to a request from another, which reads as a random failure.
    vary: "Origin",
  };

  if (method.toUpperCase() === "OPTIONS") {
    return {
      kind: "preflight",
      headers: {
        ...base,
        "access-control-allow-methods": "POST, GET, OPTIONS",
        "access-control-allow-headers": ALLOWED_REQUEST_HEADERS,
        // A day, so a tech's phone is not paying for a preflight before every
        // call on a bad connection. Browsers cap this anyway.
        "access-control-max-age": "86400",
      },
    };
  }

  return { kind: "actual", headers: base };
}
