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

// Error monitoring (src/lib/monitoring/report.server.ts) is wired in here and
// in the function middleware below, because these are the two places every
// failure passes through. Both send nothing outside a production build.
const errorMiddleware = createMiddleware().server(async ({ next, request }) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/email/")) {
    return next();
  }
  try {
    const result = await next();
    // Cron and webhook endpoints catch their own failures and answer 500, so
    // nothing is thrown for the catch below to see. A 5xx from one of them is
    // the failure; report it unless the handler already reported the
    // exception behind it.
    if (url.pathname.startsWith("/api/public/hooks/") && result.response.status >= 500) {
      const { reportFailedHookResponse } = await import("@/lib/monitoring/report.server");
      await reportFailedHookResponse(request, result.response);
    }
    return result;
  } catch (error) {
    // Reported before the statusCode check: a thrown 5xx HTTPError is a fault
    // too, and policy.isExpectedError already drops the 4xx ones.
    const { reportServerError } = await import("@/lib/monitoring/report.server");
    await reportServerError(error, { request, tags: { surface: "request" } });
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

// Every server function, unexpected exceptions only. A server function's throw
// never reaches the request middleware above: TanStack serializes it into the
// RPC response for the caller's toast, so this is the only place it is seen
// as an exception. Deliberate refusals ("Not authorized", "Invoice already
// paid", validation failures) are filtered by policy.isExpectedError; see the
// note there on how it tells them from a database fault. Rethrown unchanged,
// so what the caller sees is exactly what it saw before.
const reportServerFnErrors = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    const [{ reportServerError }, { getRequest }] = await Promise.all([
      import("@/lib/monitoring/report.server"),
      import("@tanstack/react-start/server"),
    ]);
    let request: Request | null = null;
    try {
      request = getRequest() ?? null;
    } catch {
      request = null;
    }
    await reportServerError(error, { request, tags: { surface: "server_fn" } });
    throw error;
  }
});

// The account lock (NP-12). A trial past day 14 with no plan, or a cancelled
// plan that has ended, reaches the plan picker and checkout and nothing else.
// Every server function passes through here, so the lock does not depend on
// each of them remembering it; the allowlist is in src/lib/account-lock.ts.
// Ahead of reportServerFnErrors: a refusal is a decision, not a fault.
const accountLockMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next, serverFnMeta }) => {
    const [{ refuseIfLocked }, { getRequest }] = await Promise.all([
      import("@/lib/account-lock.server"),
      import("@tanstack/react-start/server"),
    ]);
    let authorization: string | null = null;
    try {
      authorization = getRequest()?.headers.get("authorization") ?? null;
    } catch {
      authorization = null;
    }
    await refuseIfLocked({ authorization, meta: serverFnMeta });
    return next();
  },
);

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth, accountLockMiddleware, reportServerFnErrors],
  requestMiddleware: [corsMiddleware, csrfMiddleware, errorMiddleware],
  // BUILD-9: only present in a bundled native build, where the baked-in
  // "/_serverFn/..." path would resolve to the app bundle instead of the API.
  // See src/lib/server-fn-origin.ts. Absent — and dead-code-eliminated — on web.
  ...(hasNativeApiOrigin ? { serverFns: { fetch: fetchFromNativeApiOrigin } } : {}),
}));
