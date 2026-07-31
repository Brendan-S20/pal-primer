import { createStart, createMiddleware } from "@tanstack/react-start";

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
  requestMiddleware: [corsMiddleware, errorMiddleware],
  // BUILD-9: only present in a bundled native build, where the baked-in
  // "/_serverFn/..." path would resolve to the app bundle instead of the API.
  // See src/lib/server-fn-origin.ts. Absent — and dead-code-eliminated — on web.
  ...(hasNativeApiOrigin ? { serverFns: { fetch: fetchFromNativeApiOrigin } } : {}),
}));
