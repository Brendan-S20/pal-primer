import { createStart, createMiddleware, createCsrfMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { fetchFromNativeApiOrigin, hasNativeApiOrigin } from "./lib/server-fn-origin";

// BUILD-9. The native app boots from its own origin (capacitor://localhost on
// iOS, https://localhost on Android), so its server-function calls are
// cross-origin and the browser preflights them. Without an answer the app
// reaches the backend from nowhere. See src/lib/cors.server.ts for why this is
// an allowlist, why it carries no Allow-Credentials, and why it is scoped to
// the RPC path only.
//
// Registered BEFORE errorMiddleware so a preflight is answered and returned
// immediately: OPTIONS carries no Authorization by design, so letting it run on
// through the normal path would mean rejecting the request that exists to ask
// permission.
const corsMiddleware = createMiddleware().server(async ({ next, request }) => {
  const { corsDecision } = await import("@/lib/cors.server");
  const url = new URL(request.url);
  const decision = corsDecision({
    method: request.method,
    path: url.pathname,
    origin: request.headers.get("origin"),
    env: process.env.NATIVE_CORS_ORIGINS,
  });

  if (decision.kind === "ignore") return next();

  if (decision.kind === "preflight") {
    return new Response(null, { status: 204, headers: decision.headers });
  }

  // next() hands back a result wrapper, not the Response itself; the headers
  // have to go on result.response or they are silently dropped and the browser
  // rejects a reply the server thought it had allowed.
  const result = await next();
  for (const [k, v] of Object.entries(decision.headers)) {
    result.response.headers.set(k, v);
  }
  return result;
});

// ── CSRF ───────────────────────────────────────────────────────────────────
//
// THIS APP HAD NONE. createStartHandler installs a default CSRF middleware
// only when no start instance supplies requestMiddleware:
//
//   requestMiddleware: hasStartInstance ? startOptions.requestMiddleware : [defaultCsrfMiddleware]
//   (@tanstack/start-server-core createStartHandler.js, line 238)
//
// This file has supplied requestMiddleware since it was created, so the
// default was REPLACED, silently, and every server function has been
// unprotected. That was survivable only because auth is a bearer token rather
// than a cookie — but the customer portal authenticates with a COOKIE
// (hs_portal_ session, see lib/portal-auth.server.ts), and portal server
// functions reschedule visits, cancel add-ons and toggle autopay. A cookie the
// browser attaches automatically plus no CSRF check is the actual, exploitable
// shape.
//
// THE TRAP IN CONFIGURING IT. Sec-Fetch-Site SHORT-CIRCUITS the whole check:
// if the header is present, the library consults `secFetchSite` and never
// looks at Origin at all. The native app is legitimately cross-site — it runs
// on capacitor://localhost — so it fails the default. But writing
// `secFetchSite: ["same-origin", "cross-site"]` to admit it would allow EVERY
// site on the internet, which is CSRF fully disabled while looking configured.
//
// So the matcher is a function: same-origin passes (that is the web app), and
// anything else has to name an origin on the native allowlist — the same list
// CORS uses, imported rather than repeated.
const csrfMiddleware = createCsrfMiddleware({
  // Server functions only, matching the library's own default. Public webhooks
  // (Stripe, Twilio) are route handlers, not server functions, and are
  // legitimately cross-site with their own signature verification — blocking
  // those would break payments.
  filter: (ctx) => (ctx as { handlerType?: string }).handlerType === "serverFn",
  secFetchSite: async (value, ctx) => {
    if (value === "same-origin") return true;
    // 'cross-site', 'same-site' and 'none' are only ever legitimate here when
    // the caller is the native shell, which always sends its Origin.
    const { isAllowedOrigin } = await import("@/lib/cors.server");
    return isAllowedOrigin(ctx.request.headers.get("origin"), process.env.NATIVE_CORS_ORIGINS);
  },
  // Reached only when Sec-Fetch-Site is absent (an older WebView). Supplying
  // `origin` replaces the library's built-in same-origin comparison, so that
  // has to be restated here or the web app would start failing its own calls.
  origin: async (value, ctx) => {
    if (value === new URL(ctx.request.url).origin) return true;
    const { isAllowedOrigin } = await import("@/lib/cors.server");
    return isAllowedOrigin(value, process.env.NATIVE_CORS_ORIGINS);
  },
  // A request with no Sec-Fetch-Site, no Origin and no Referer stays refused.
  allowRequestsWithoutOriginCheck: false,
});

const errorMiddleware = createMiddleware().server(async ({ next, request }) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/email/")) {
    return next();
  }
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [corsMiddleware, csrfMiddleware, errorMiddleware],
  // BUILD-9: only present in a bundled native build, where the baked-in
  // "/_serverFn/..." path would resolve to the app bundle instead of the API.
  // See src/lib/server-fn-origin.ts. Absent — and dead-code-eliminated — on web.
  ...(hasNativeApiOrigin ? { serverFns: { fetch: fetchFromNativeApiOrigin } } : {}),
}));
